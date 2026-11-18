# 访学课程候补采集服务

这是一个用于访学课程候补的本地数据采集与归档服务。当前版本从仓库自带的合成来源记录读取一页数据，经过字段规整后写入进程内目录；来源内容和规整后的记录保留独立边界，便于在不访问外部系统的情况下复现采集过程。

## 运行

需要 Node.js 20 或更高版本，不需要安装第三方依赖。

```sh
npm test
npm run build
node src/pipeline.mjs
```

测试使用项目内的合成记录；执行不需要网络、凭据或外部服务。

## 候补看板

`src/waitlist.mjs` 在采集层之上提供候补领域逻辑，面向两类来源：网页名额快照（权威来源）和合作院校通知邮件（可能重复、可能晚于网页的关闭信息到达）。

```js
import { WaitlistBoard } from './src/waitlist.mjs';

const board = new WaitlistBoard();
board.applySnapshot({ courseId: 'c1', state: 'open', remaining: 1, revision: 1 });
board.applyNotification({ notificationId: 'n1', courseId: 'c1', state: 'open' });
board.waitlist('s1', 'c1');          // 名额耗尽，课程表立即呈现为关闭
board.schedule();                    // { courses: [{ id: 'c1', state: 'closed', remaining: 0, ... }] }
```

看板保证以下不变式：

- **候补幂等**：同一学生在同一课程上只保留一条候补记录；重复通知引发的重复候补返回已有记录（`duplicate: true`），不产生第二条。
- **关闭不重开**：已关闭的课程不会被邮件重新开放，只能由修订号严格更新的快照重新开放（代表新的名额周期）。
- **过期事件拒绝**：修订号更旧的快照和邮件被拒绝（`stale-revision`），不会回退课程状态；重复邮件按通知编号去重（`duplicate-notification`）。
- **课程表实时呈现**：候补操作立即扣减剩余名额，名额耗尽时课程自动关闭（`closeReason: 'exhausted'`）；`schedule()` 反映截至调用时所有已应用的快照、邮件和候补操作，`events()` 提供含拒绝原因的审计轨迹。
