import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    /* 失败时要能一眼看出**是哪一条、为什么**。
       默认 reporter 在全绿时只打一行汇总，偶发红一次又被下一次全绿冲掉，
       就只剩「441 条里红了 1 条」这种查不下去的信息（2026-09-15 实际发生过一次）。
       verbose 会把每条用例名逐行打出来，红的那条连同断言一起留在输出里。 */
    reporters: ['verbose'],
    /* 一条红不许提前收摊：偶发问题要的是「这一轮里还有谁也红了」。 */
    bail: 0,
    /* 断言失败时别把对象截成 `{ …(11) }` —— 那正是这次查偶发红时最缺的东西。
       0 = 不截断（chai 的 truncateThreshold 语义）。 */
    chaiConfig: { truncateThreshold: 0 }
  }
})
