export const COURSE_OPEN = 'open';
export const COURSE_CLOSED = 'closed';

const STATES = new Set([COURSE_OPEN, COURSE_CLOSED]);

function normalizeId(value, field) {
  const id = String(value ?? '').trim();
  if (!id) {
    throw new Error(`缺少 ${field}`);
  }
  return id;
}

function normalizeState(value) {
  const state = String(value ?? '').trim();
  if (!STATES.has(state)) {
    throw new Error(`未知课程状态: ${value}`);
  }
  return state;
}

function normalizeRemaining(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const remaining = Number(value);
  if (!Number.isInteger(remaining) || remaining < 0) {
    throw new Error(`剩余名额必须是非负整数: ${value}`);
  }
  return remaining;
}

function normalizeRevision(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const revision = Number(value);
  if (!Number.isFinite(revision)) {
    throw new Error(`修订号必须是数字: ${value}`);
  }
  return revision;
}

function normalizeName(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const name = String(value).trim();
  return name || null;
}

/**
 * 访学课程候补看板。
 *
 * 汇总两个渠道的课程状态：网页名额快照（applySnapshot，权威来源）和合作院校
 * 通知邮件（applyNotification，可能重复、可能晚于网页的关闭信息）。在此之上
 * 执行候补操作（waitlist），并通过 schedule() 呈现课程表。
 *
 * 不变式：
 * - 同一学生在同一课程上只会出现一条候补记录（重复触发返回已有记录）；
 * - 已关闭的课程不会被邮件重新开放，只能由修订号更新的快照重新开放；
 * - 修订号更旧的快照和邮件会被拒绝，不会回退课程状态；
 * - 候补操作立即反映到课程表（剩余名额扣减、名额耗尽自动关闭）。
 */
export class WaitlistBoard {
  #courses = new Map();
  #entries = new Map();
  #seenNotifications = new Set();
  #events = [];
  #now;

  constructor({ now = () => new Date().toISOString() } = {}) {
    this.#now = now;
  }

  /**
   * 应用网页名额快照。快照是权威来源：可以关闭课程，也可以在修订号更新时
   * 重新开放课程（新的名额周期）。返回 { applied, course? , reason? }。
   */
  applySnapshot(snapshot, { at = this.#now() } = {}) {
    const courseId = normalizeId(snapshot.courseId, 'courseId');
    const state = normalizeState(snapshot.state);
    const remaining = normalizeRemaining(snapshot.remaining);
    const revision = normalizeRevision(snapshot.revision);
    const name = normalizeName(snapshot.name);
    const course = this.#courses.get(courseId);

    if (course && this.#isStale(course, revision)) {
      return this.#reject('snapshot', courseId, 'stale-revision', at);
    }
    if (course?.state === COURSE_CLOSED && state === COURSE_OPEN && !this.#isNewer(course, revision)) {
      // 已关闭的课程只能由修订号严格更新的快照重新开放，避免过期信息回流。
      return this.#reject('snapshot', courseId, 'course-closed', at);
    }

    const target = course ?? this.#register(courseId);
    this.#apply(target, { state, remaining, revision, name, at });
    this.#log({ channel: 'snapshot', courseId, applied: true, at });
    return { applied: true, course: this.#view(target) };
  }

  /**
   * 应用合作院校通知邮件。邮件按 notificationId 去重；无论修订号如何，
   * 邮件都不能把已关闭的课程重新开放。返回 { applied, course?, reason? }。
   */
  applyNotification(notification, { at = this.#now() } = {}) {
    const notificationId = normalizeId(notification.notificationId, 'notificationId');
    const courseId = normalizeId(notification.courseId, 'courseId');
    const state = normalizeState(notification.state);
    const remaining = normalizeRemaining(notification.remaining);
    const revision = normalizeRevision(notification.revision);
    const name = normalizeName(notification.name);

    if (this.#seenNotifications.has(notificationId)) {
      return this.#reject('notification', courseId, 'duplicate-notification', at, { notificationId });
    }
    this.#seenNotifications.add(notificationId);

    const course = this.#courses.get(courseId);
    if (course && this.#isStale(course, revision)) {
      return this.#reject('notification', courseId, 'stale-revision', at, { notificationId });
    }
    if (course?.state === COURSE_CLOSED && state === COURSE_OPEN) {
      // 邮件可能晚于网页的关闭信息到达，一律不得重新开放已关闭的课程。
      return this.#reject('notification', courseId, 'course-closed', at, { notificationId });
    }

    const target = course ?? this.#register(courseId);
    this.#apply(target, { state, remaining, revision, name, at });
    this.#log({ channel: 'notification', courseId, applied: true, at, notificationId });
    return { applied: true, course: this.#view(target) };
  }

  /**
   * 为学生在课程上登记候补。同一学生重复候补同一课程时返回已有记录
   * （duplicate: true），不会产生第二条。课程未开放、名额耗尽或课程
   * 不存在时返回 { applied: false, reason }。
   */
  waitlist(studentId, courseId, { at = this.#now() } = {}) {
    const student = normalizeId(studentId, 'studentId');
    const cid = normalizeId(courseId, 'courseId');
    const key = JSON.stringify([student, cid]);

    const existing = this.#entries.get(key);
    if (existing) {
      return { applied: true, duplicate: true, entry: structuredClone(existing) };
    }

    const course = this.#courses.get(cid);
    if (!course) {
      return this.#reject('waitlist', cid, 'unknown-course', at, { studentId: student });
    }
    if (course.state !== COURSE_OPEN) {
      return this.#reject('waitlist', cid, 'course-not-open', at, { studentId: student });
    }
    if (course.remaining !== null && course.remaining <= 0) {
      return this.#reject('waitlist', cid, 'no-quota', at, { studentId: student });
    }

    const entry = {
      studentId: student,
      courseId: cid,
      position: course.waitlist.length + 1,
      createdAt: at,
    };
    this.#entries.set(key, entry);
    course.waitlist.push(key);
    if (course.remaining !== null) {
      course.remaining -= 1;
      if (course.remaining === 0) {
        course.state = COURSE_CLOSED;
        course.closeReason = 'exhausted';
      }
    }
    course.updatedAt = at;
    this.#log({ channel: 'waitlist', courseId: cid, applied: true, at, studentId: student });
    return { applied: true, duplicate: false, entry: structuredClone(entry) };
  }

  /**
   * 课程表呈现：每门课程的当前状态、剩余名额、关闭原因和候补名单，
   * 反映截至调用时所有已应用的快照、邮件和候补操作。
   */
  schedule() {
    const courses = [...this.#courses.values()]
      .map((course) => this.#view(course))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { courses };
  }

  /** 已处理事件的审计轨迹（含被拒绝的事件及原因），按到达顺序排列。 */
  events() {
    return this.#events.map((event) => ({ ...event }));
  }

  #register(courseId) {
    const course = {
      id: courseId,
      name: courseId,
      state: COURSE_OPEN,
      remaining: null,
      revision: null,
      closeReason: null,
      updatedAt: null,
      waitlist: [],
    };
    this.#courses.set(courseId, course);
    return course;
  }

  #apply(course, { state, remaining, revision, name, at }) {
    if (state === COURSE_OPEN) {
      course.closeReason = null;
    } else if (course.state !== COURSE_CLOSED) {
      // 记录首次关闭的来源；名额耗尽后再收到关闭信息时保留 exhausted。
      course.closeReason = 'source';
    }
    course.state = state;
    if (remaining !== null) {
      course.remaining = remaining;
    }
    if (revision !== null && (course.revision === null || revision > course.revision)) {
      course.revision = revision;
    }
    if (name !== null) {
      course.name = name;
    }
    course.updatedAt = at;
  }

  #isStale(course, revision) {
    return revision !== null && course.revision !== null && revision < course.revision;
  }

  #isNewer(course, revision) {
    return revision !== null && (course.revision === null || revision > course.revision);
  }

  #reject(channel, courseId, reason, at, extra = {}) {
    this.#log({ channel, courseId, applied: false, reason, at, ...extra });
    return { applied: false, reason };
  }

  #log(event) {
    this.#events.push(event);
  }

  #view(course) {
    return {
      id: course.id,
      name: course.name,
      state: course.state,
      remaining: course.remaining,
      closeReason: course.closeReason,
      revision: course.revision,
      updatedAt: course.updatedAt,
      waitlist: course.waitlist.map((key) => structuredClone(this.#entries.get(key))),
    };
  }
}
