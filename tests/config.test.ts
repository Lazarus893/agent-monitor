/**
 * 横向压缩补偿：换算与配置读写（M3 附加节）。
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CONFIG_FILE, DEFAULT_PREFS, PANEL_X_COMPRESSED, PANEL_X_NATIVE, PanelXConfig,
  configFile, defaultPanelX, readConfig, readPrefs, writeConfig, writePref
} from '../src/main/config.js'
import { canvasWidthFor, clampPanelX, scaleFor } from '../src/shared/scale.js'

const COMPRESSED = { width: 480, height: 270 }
const NATIVE = { width: 480, height: 320 }

describe('换算', () => {
  it('480 / 1.19 → 403（用户实测的那个系数）', () => {
    expect(canvasWidthFor(480, 1.19)).toBe(403)
  })

  it('panelX = 1 时画布宽度不变', () => {
    expect(canvasWidthFor(480, 1)).toBe(480)
  })

  it('横向倍率恰好是 2 × 实测系数，不是从窗口宽度反推的比值', () => {
    const s = scaleFor(COMPRESSED, 1.19)
    expect(s.w).toBe(403)
    expect(s.h).toBe(270)
    expect(s.sy).toBe(2)
    // 两个倍率相除 = 用户量出来的那个数，一位小数都不差（960/403 会得到 1.19107）
    expect(s.sx / s.sy).toBe(1.19)
    expect(s.h * s.sy).toBe(540)
    // 代价：右边差 0.86 逻辑像素，底色同为 --canvas，屏上看不出来
    expect(960 - s.w * s.sx).toBeCloseTo(0.86, 2)
  })

  it('原生 960×640 模式：不补偿，画布 480×320', () => {
    const s = scaleFor(NATIVE, 1)
    expect([s.w, s.h, s.sx, s.sy]).toEqual([480, 320, 2, 2])
  })

  it('量化到 0.01，夹在 [1.0, 1.35]', () => {
    expect(clampPanelX(1.1900000000000004)).toBe(1.19)
    expect(clampPanelX(0.5)).toBe(1)
    expect(clampPanelX(99)).toBe(1.35)
    expect(clampPanelX(NaN)).toBe(1)
  })
})

describe('默认值按显示模式分档', () => {
  it('960×540 → 1.19，960×640 → 1.0', () => {
    expect(defaultPanelX(COMPRESSED)).toBe(PANEL_X_COMPRESSED)
    expect(defaultPanelX(NATIVE)).toBe(PANEL_X_NATIVE)
  })
})

describe('配置文件', () => {
  const tmp = (): string => join(mkdtempSync(join(tmpdir(), 'cfg-')), 'config.json')

  it('不存在时创建一份，值是当前模式的默认', () => {
    const file = tmp()
    const p = new PanelXConfig(COMPRESSED, file)
    expect(p.get()).toBe(1.19)
    expect(JSON.parse(readFileSync(file, 'utf8')).panelX).toBe(1.19)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('坏 JSON / 非数字 panelX 回落默认，不抛', () => {
    const file = tmp()
    writeFileSync(file, '{ broken')
    expect(readConfig(file)).toEqual({})           // 读不出来时连 touched 都没有
    writeFileSync(file, '{"panelX":"1.19"}')
    expect(readConfig(file)).toEqual({ touched: false })
    expect(new PanelXConfig(COMPRESSED, file).get()).toBe(1.19)
  })

  it('±0.02 写回配置并量化', () => {
    const file = tmp()
    const p = new PanelXConfig(COMPRESSED, file)
    expect(p.nudge(0.02)).toBe(1.21)
    expect(p.nudge(-0.02)).toBe(1.19)
    expect(JSON.parse(readFileSync(file, 'utf8')).panelX).toBe(1.19)
  })

  it('复核 P1-②：跨进程也要认得「没调过」—— 第二次启动切原生模式仍回 1.0', () => {
    const file = tmp()
    // 第一次启动：写出默认配置
    expect(new PanelXConfig(COMPRESSED, file).get()).toBe(1.19)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ panelX: 1.19, touched: false })
    // 第二次启动，切到原生 960×640 —— 原来这里会读成「用户调过」，卡在 1.19（画面横向拉伸 19%）
    expect(new PanelXConfig(NATIVE, file).get()).toBe(1)
    expect(new PanelXConfig(COMPRESSED, file).get()).toBe(1.19)
  })

  it('M3 第一版写的 {panelX} 没有 touched 位 → 按「没调过」算，自动复位', () => {
    const file = tmp()
    writeFileSync(file, JSON.stringify({ panelX: 1.19 }))
    expect(new PanelXConfig(NATIVE, file).get()).toBe(1)
  })

  it('真的手调过就跨进程保持', () => {
    const file = tmp()
    new PanelXConfig(COMPRESSED, file).nudge(0.02)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ panelX: 1.21, touched: true })
    expect(new PanelXConfig(NATIVE, file).get()).toBe(1.21)
  })

  it('手调过之后不再被显示模式的默认覆盖', () => {
    const file = tmp()
    const p = new PanelXConfig(COMPRESSED, file)
    p.nudge(0.02)                       // → 1.21，从此 touched
    expect(p.onCanvas(NATIVE)).toBe(1.21)
    // ⌃⌥0 复位：回到当前模式默认，并清掉「手调过」
    expect(p.reset(NATIVE)).toBe(1)
    expect(p.onCanvas(COMPRESSED)).toBe(1.19)
  })

  it('没手调过时跟着显示模式走', () => {
    const p = new PanelXConfig(COMPRESSED, tmp())
    expect(p.onCanvas(NATIVE)).toBe(1)
    expect(p.onCanvas(COMPRESSED)).toBe(1.19)
  })

  it('下一次启动读回用户调过的值', () => {
    const file = tmp()
    new PanelXConfig(COMPRESSED, file).nudge(0.04)
    expect(new PanelXConfig(COMPRESSED, file).get()).toBe(1.23)
  })

  it('⌃⌥0 复位之后，下一次启动又跟着显示模式走', () => {
    const file = tmp()
    const p = new PanelXConfig(COMPRESSED, file)
    p.nudge(0.04)
    p.reset(COMPRESSED)
    expect(new PanelXConfig(NATIVE, file).get()).toBe(1)
  })

  it('路径可用环境变量覆盖（selftest 靠它不碰真实 config.json）', () => {
    expect(configFile('/tmp/x/config.json')).toBe('/tmp/x/config.json')
    expect(configFile(undefined)).toBe(DEFAULT_CONFIG_FILE)
    expect(configFile('   ')).toBe(DEFAULT_CONFIG_FILE)
  })

  it('写不进去时返回 false，不抛', () => {
    expect(writeConfig({ panelX: 1.19 }, '/proc/nope/config.json')).toBe(false)
  })
})

/* ==========================================================================
   M4 · 托盘的三个开关与合并写。
   M3 复核 §3.4 把「writeConfig 整份覆盖」记成前向陷阱；M4 加了三个字段之后
   它立刻会变成真 bug（勾一下静音把校准出来的 panelX 冲掉），所以在这里钉死。
   ========================================================================== */

describe('托盘偏好', () => {
  const tmp = (): string => join(mkdtempSync(join(tmpdir(), 'cfg-prefs-')), 'config.json')

  it('默认值：不静音、不置顶、登录自启开', () => {
    expect(readPrefs(tmp())).toEqual(DEFAULT_PREFS)
    expect(DEFAULT_PREFS).toEqual({ muted: false, alwaysOnTop: false, openAtLogin: true, typingFollow: true })
  })

  it('写一个开关不会动到 panelX', () => {
    const file = tmp()
    const p = new PanelXConfig({ width: 480, height: 270 }, file)
    p.nudge(0.02)                       // panelX 1.21，touched 真
    writePref('muted', true, file)
    const cfg = readConfig(file)
    expect(cfg.panelX).toBe(1.21)
    expect(cfg.touched).toBe(true)
    expect(cfg.muted).toBe(true)
    // 反过来也一样：调 panelX 不该把静音抹掉
    p.nudge(0.02)
    expect(readConfig(file).muted).toBe(true)
  })

  it('用户手加的字段不会被抹掉', () => {
    const file = tmp()
    writeFileSync(file, JSON.stringify({ panelX: 1.19, 我的备注: 'hi' }))
    writePref('alwaysOnTop', true, file)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    expect(raw['我的备注']).toBe('hi')
    expect(raw.alwaysOnTop).toBe(true)
    expect(raw.panelX).toBe(1.19)
  })

  it('非布尔值一律当没写过，回落默认', () => {
    const file = tmp()
    writeFileSync(file, JSON.stringify({ muted: 'yes', alwaysOnTop: 1, openAtLogin: null }))
    expect(readPrefs(file)).toEqual(DEFAULT_PREFS)
  })

  it('坏 JSON 也能写进去（当它不存在，从 patch 起一份新的）', () => {
    const file = tmp()
    writeFileSync(file, '{ broken')
    expect(writePref('muted', true, file)).toBe(true)
    expect(readPrefs(file).muted).toBe(true)
  })
})
