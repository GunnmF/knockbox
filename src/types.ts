/** 跨模块共享的类型。 */

/**
 * 主窗口的两个视图。
 *
 * 单窗口两态：默认是启动器，托盘菜单的「设置…」把它换成管理页。
 * 拆成独立文件是因为窗口高度策略（见 hooks/useWindowFit.ts）也要判断它，
 * 从 App.tsx 导入会绕成循环依赖。
 */
export type View = 'launcher' | 'settings'
