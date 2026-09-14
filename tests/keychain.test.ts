/**
 * Keychain 写入的两处纯逻辑（M4 §1「连接 ZCode」）。
 *
 * 不跑真的 `security` —— 那会往用户钥匙串里写东西。这里只钉住两件事：
 *   1. `security -i` 的命令行转义（错了会静默存进一个被截断的 Key，
 *      而面板那边只会显示「未连接」，根本查不到是转义丢了半截）；
 *   2. service / account 的环境变量覆盖（验收用临时项走往返，不碰真实那条）。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  keychainTarget, quoteForSecurity, setKeychainOverrideAllowed
} from '../src/main/collectors/quota/keychain.js'
import { validateKey } from '../src/main/connect.js'
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE } from '../src/main/collectors/quota/zcode.js'

describe('security -i 的转义', () => {
  it('普通 Key 原样包一层引号', () => {
    expect(quoteForSecurity('abc123.def456')).toBe('"abc123.def456"')
  })

  it('空格不会把命令行断成两段', () => {
    expect(quoteForSecurity('a b')).toBe('"a b"')
  })

  it('双引号与反斜杠都转义', () => {
    // 实测过：security -i 认这套转义，读回来与原串逐字相同
    expect(quoteForSecurity('a b"c\\d')).toBe('"a b\\"c\\\\d"')
  })

  it('先转反斜杠再转引号 —— 顺序反了会多出一根反斜杠', () => {
    expect(quoteForSecurity('\\"')).toBe('"\\\\\\""')
  })

  it('空串也有引号，不会让 -w 吃掉下一个参数', () => {
    expect(quoteForSecurity('')).toBe('""')
  })
})

describe('service / account 覆盖', () => {
  it('没给环境变量就是真实那条', () => {
    expect(keychainTarget(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, {})).toEqual({
      service: 'agent-monitor', account: 'zcode-bigmodel'
    })
  })

  it('给了就换成临时项（验收往返用，绝不动真实那条）', () => {
    const env = {
      MONITOR_KEYCHAIN_SERVICE: 'agent-monitor-m4test',
      MONITOR_KEYCHAIN_ACCOUNT: 'probe'
    }
    expect(keychainTarget(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, env)).toEqual({
      service: 'agent-monitor-m4test', account: 'probe'
    })
  })

  it('空白值当没给', () => {
    const env = { MONITOR_KEYCHAIN_SERVICE: '  ', MONITOR_KEYCHAIN_ACCOUNT: '' }
    expect(keychainTarget(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, env).service).toBe('agent-monitor')
  })
})

describe('打包后忽略项名覆盖（M4 复核 P1-②）', () => {
  const env = {
    MONITOR_KEYCHAIN_SERVICE: '坏人指定的项名',
    MONITOR_KEYCHAIN_ACCOUNT: '坏人指定的账户'
  }

  afterEach(() => setKeychainOverrideAllowed(true))

  it('关掉之后，环境变量一个字都不认', () => {
    setKeychainOverrideAllowed(false)
    expect(keychainTarget(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, env)).toEqual({
      service: 'agent-monitor', account: 'zcode-bigmodel'
    })
  })

  it('重新打开之后又认（dev 与自检要用）', () => {
    setKeychainOverrideAllowed(false)
    setKeychainOverrideAllowed(true)
    expect(keychainTarget(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, env).service).toBe('坏人指定的项名')
  })

  it('默认是开的 —— 单测与脚本跑在 Electron 之外，没人会调这个开关', () => {
    expect(keychainTarget(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, env).service).toBe('坏人指定的项名')
  })
})

describe('渲染层 URL 也关在 isPackaged 后面（M4 复核 P1-②）', () => {
  it('index.ts 不再直读 ELECTRON_RENDERER_URL', () => {
    const src = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    // 只允许出现在那一行门控赋值里
    const hits = [...src.matchAll(/process\.env\.ELECTRON_RENDERER_URL/g)]
    expect(hits).toHaveLength(1)
    expect(src).toMatch(/const rendererUrl = app\.isPackaged \? undefined : process\.env\.ELECTRON_RENDERER_URL/)
    expect(src).toMatch(/setKeychainOverrideAllowed\(!app\.isPackaged\)/)
  })
})

describe('validateKey —— 连接窗口那道闸门（M4 复核 §1.7）', () => {
  it('正常 Key 通过，并且顺手 trim 掉首尾空白', () => {
    expect(validateKey('  abc123.def456 \n')).toEqual({ ok: true, key: 'abc123.def456' })
  })

  it('非文本、空串、只有空白 —— 各自一句话', () => {
    expect(validateKey(undefined)).toEqual({ ok: false, message: 'Key 必须是文本' })
    expect(validateKey(42)).toEqual({ ok: false, message: 'Key 必须是文本' })
    expect(validateKey({})).toEqual({ ok: false, message: 'Key 必须是文本' })
    expect(validateKey('')).toEqual({ ok: false, message: '请先粘贴 Key' })
    expect(validateKey('   ')).toEqual({ ok: false, message: '请先粘贴 Key' })
  })

  it('控制字符一律拒 —— 换行是 security -i 命令流注入的载体', () => {
    for (const bad of ['a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u007fb']) {
      const r = validateKey(bad)
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.message).toBe('Key 里有不可见字符，请重新复制')
    }
  })

  it('注入一条 add-generic-password 也过不去（换行被挡在前面）', () => {
    expect(validateKey('x\nadd-generic-password -U -s 别的项 -a 别的账户 -w 坏值').ok).toBe(false)
  })

  it('引号 / 反斜杠 / 空格是**合法**的，交给 quoteForSecurity 转义，不在这里拒', () => {
    expect(validateKey('a b"c\\d')).toEqual({ ok: true, key: 'a b"c\\d' })
  })
})
