import test from 'node:test';
import assert from 'node:assert/strict';
import { WaitlistBoard } from '../src/waitlist.mjs';

const T0 = '2026-11-17T08:00:00.000Z';
const T1 = '2026-11-17T09:00:00.000Z';
const T2 = '2026-11-17T10:00:00.000Z';
const T3 = '2026-11-17T11:00:00.000Z';
const T4 = '2026-11-17T12:00:00.000Z';

test('网页关闭后迟到的重复开放邮件不会重开课程或重复候补', () => {
  const board = new WaitlistBoard();

  // 网页快照：课程开放，剩余 1 个名额。
  board.applySnapshot(
    { courseId: 'c1', name: '访学课程甲', state: 'open', remaining: 1, revision: 1 },
    { at: T0 },
  );
  // 合作院校邮件：名额开放（第一次到达）。
  const firstMail = board.applyNotification(
    { notificationId: 'n1', courseId: 'c1', state: 'open', revision: 1 },
    { at: T1 },
  );
  assert.equal(firstMail.applied, true);

  // 教务助理安排候补，名额耗尽，课程在课程表上立即呈现为关闭。
  const seat = board.waitlist('s1', 'c1', { at: T1 });
  assert.equal(seat.applied, true);
  assert.equal(seat.duplicate, false);
  assert.equal(board.schedule().courses[0].state, 'closed');
  assert.equal(board.schedule().courses[0].closeReason, 'exhausted');

  // 网页快照：合作院校关闭名额。
  board.applySnapshot({ courseId: 'c1', state: 'closed', remaining: 0, revision: 2 }, { at: T2 });

  // 同一封邮件重复到达：按通知编号去重，不产生任何影响。
  const dupMail = board.applyNotification(
    { notificationId: 'n1', courseId: 'c1', state: 'open', revision: 1 },
    { at: T3 },
  );
  assert.equal(dupMail.applied, false);
  assert.equal(dupMail.reason, 'duplicate-notification');

  // 另一封迟到的开放邮件（不同编号、缺少修订号）：不得重开已关闭课程。
  const lateMail = board.applyNotification(
    { notificationId: 'n2', courseId: 'c1', state: 'open' },
    { at: T3 },
  );
  assert.equal(lateMail.applied, false);
  assert.equal(lateMail.reason, 'course-closed');

  // 重复通知引发的重复候补：返回已有记录，不出现第二条。
  const again = board.waitlist('s1', 'c1', { at: T3 });
  assert.equal(again.applied, true);
  assert.equal(again.duplicate, true);
  assert.equal(again.entry.position, 1);

  // 课程表最终呈现：仍关闭、剩余 0、只有一条候补。
  const [view] = board.schedule().courses;
  assert.equal(view.state, 'closed');
  assert.equal(view.remaining, 0);
  assert.deepEqual(view.waitlist.map((entry) => entry.studentId), ['s1']);
});

test('修订号更旧的快照和邮件被拒绝，不回退课程状态', () => {
  const board = new WaitlistBoard();
  board.applySnapshot({ courseId: 'c1', state: 'open', remaining: 2, revision: 3 }, { at: T0 });

  const staleSnap = board.applySnapshot(
    { courseId: 'c1', state: 'open', remaining: 9, revision: 2 },
    { at: T1 },
  );
  assert.equal(staleSnap.applied, false);
  assert.equal(staleSnap.reason, 'stale-revision');

  const staleMail = board.applyNotification(
    { notificationId: 'n1', courseId: 'c1', state: 'closed', revision: 1 },
    { at: T1 },
  );
  assert.equal(staleMail.applied, false);
  assert.equal(staleMail.reason, 'stale-revision');

  const [view] = board.schedule().courses;
  assert.equal(view.state, 'open');
  assert.equal(view.remaining, 2);
  assert.equal(view.revision, 3);
});

test('邮件即使修订号更新也不能重开已关闭课程，快照可以', () => {
  const board = new WaitlistBoard();
  board.applySnapshot({ courseId: 'c1', state: 'closed', remaining: 0, revision: 2 }, { at: T0 });

  const mail = board.applyNotification(
    { notificationId: 'n1', courseId: 'c1', state: 'open', remaining: 5, revision: 3 },
    { at: T1 },
  );
  assert.equal(mail.applied, false);
  assert.equal(mail.reason, 'course-closed');
  assert.equal(board.schedule().courses[0].state, 'closed');

  // 修订号不更新的快照同样不能重开（防止过期快照回流）。
  const equalSnap = board.applySnapshot(
    { courseId: 'c1', state: 'open', remaining: 5, revision: 2 },
    { at: T2 },
  );
  assert.equal(equalSnap.applied, false);
  assert.equal(equalSnap.reason, 'course-closed');

  // 修订号严格更新的快照代表新的名额周期，可以重新开放。
  const newCycle = board.applySnapshot(
    { courseId: 'c1', state: 'open', remaining: 2, revision: 3 },
    { at: T3 },
  );
  assert.equal(newCycle.applied, true);
  const [view] = board.schedule().courses;
  assert.equal(view.state, 'open');
  assert.equal(view.remaining, 2);
  assert.equal(view.closeReason, null);
});

test('候补操作立即呈现在课程表，名额耗尽后拒绝新的候补', () => {
  const board = new WaitlistBoard();
  board.applySnapshot({ courseId: 'c1', state: 'open', remaining: 2, revision: 1 }, { at: T0 });

  board.waitlist('s1', 'c1', { at: T1 });
  let [view] = board.schedule().courses;
  assert.equal(view.state, 'open');
  assert.equal(view.remaining, 1);
  assert.deepEqual(view.waitlist.map((entry) => entry.studentId), ['s1']);

  board.waitlist('s2', 'c1', { at: T2 });
  [view] = board.schedule().courses;
  assert.equal(view.state, 'closed');
  assert.equal(view.closeReason, 'exhausted');
  assert.equal(view.remaining, 0);
  assert.deepEqual(
    view.waitlist.map((entry) => [entry.studentId, entry.position]),
    [['s1', 1], ['s2', 2]],
  );

  const rejected = board.waitlist('s3', 'c1', { at: T3 });
  assert.equal(rejected.applied, false);
  assert.equal(rejected.reason, 'course-not-open');
});

test('未开放或未知课程上的候补被拒绝', () => {
  const board = new WaitlistBoard();
  board.applySnapshot({ courseId: 'c1', state: 'closed', remaining: 0, revision: 1 }, { at: T0 });

  const closed = board.waitlist('s1', 'c1', { at: T1 });
  assert.equal(closed.applied, false);
  assert.equal(closed.reason, 'course-not-open');

  const unknown = board.waitlist('s1', 'c9', { at: T1 });
  assert.equal(unknown.applied, false);
  assert.equal(unknown.reason, 'unknown-course');
});

test('快照与候补操作交错时课程表正确呈现状态变化', () => {
  const board = new WaitlistBoard();
  board.applySnapshot({ courseId: 'c1', state: 'open', remaining: 2, revision: 1 }, { at: T0 });
  board.waitlist('s1', 'c1', { at: T1 });

  // 新快照是权威来源：剩余名额以其为准，已有候补记录保留。
  board.applySnapshot({ courseId: 'c1', state: 'open', remaining: 3, revision: 2 }, { at: T2 });
  const [view] = board.schedule().courses;
  assert.equal(view.remaining, 3);
  assert.deepEqual(view.waitlist.map((entry) => entry.studentId), ['s1']);

  // 重新开放后同一学生仍不重复候补。
  const again = board.waitlist('s1', 'c1', { at: T3 });
  assert.equal(again.duplicate, true);
  assert.equal(board.schedule().courses[0].waitlist.length, 1);
});

test('邮件可以为尚未登记的课程建档', () => {
  const board = new WaitlistBoard();
  const result = board.applyNotification(
    { notificationId: 'n1', courseId: 'c1', name: '访学课程乙', state: 'open', remaining: 1 },
    { at: T0 },
  );
  assert.equal(result.applied, true);

  const seat = board.waitlist('s1', 'c1', { at: T1 });
  assert.equal(seat.applied, true);
  const [view] = board.schedule().courses;
  assert.equal(view.name, '访学课程乙');
  assert.equal(view.state, 'closed');
});

test('事件审计轨迹包含被拒绝的事件及原因', () => {
  const board = new WaitlistBoard();
  board.applySnapshot({ courseId: 'c1', state: 'closed', remaining: 0, revision: 1 }, { at: T0 });
  board.applyNotification({ notificationId: 'n1', courseId: 'c1', state: 'open' }, { at: T1 });
  board.applyNotification({ notificationId: 'n1', courseId: 'c1', state: 'open' }, { at: T2 });

  const rejected = board.events().filter((event) => !event.applied);
  assert.deepEqual(
    rejected.map((event) => event.reason),
    ['course-closed', 'duplicate-notification'],
  );
});

test('畸形输入被拒绝', () => {
  const board = new WaitlistBoard();
  assert.throws(() => board.applySnapshot({ courseId: 'c1', state: 'weird' }));
  assert.throws(() => board.applySnapshot({ state: 'open' }));
  assert.throws(() => board.applyNotification({ notificationId: 'n1', courseId: 'c1' }));
  assert.throws(() => board.applySnapshot({ courseId: 'c1', state: 'open', remaining: -1 }));
  assert.throws(() => board.waitlist('', 'c1'));
});
