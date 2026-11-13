# UI、主题与交互规范

修改 renderer 组件、主题、对话框或共享控件前阅读。具体功能布局见对应专题；这里仅维护跨组件规则。

## 组件、布局与错误

- 优先复用 `components/ui` 的 shadcn 封装，图标用 lucide-react，不手画 SVG；匹配任务时阅读项目 shadcn／diffs 等 skill。
- Tailwind 放在组件 className，优先间距刻度、size-*、分数尺寸与语义 token；刻度无法表达或 keyframes／伪元素才用 module.css 或任意值。
- 间距刻度 `--spacing` 是 `0.25rem`，px 数值除以 4 即类名，例如 `px-[18px]` 改为 `px-4.5`；百分比优先 `max-w-1/2` 等分数。仅刻度无法表达、keyframes 或伪元素才用任意值／module.css。
- 普通 UI 字体为 Geist Variable，中文引号使用 LXGW WenKai Lite；代码等宽字体为 Lilex Variable，终端另用 Lilex Nerd Font Mono，详见 [终端](terminal.md)。
- IPC 错误使用 `lib/ipc-error.ts` 的 failureMessage，不在组件里另写原始错误转换。
- IME 组字时 Enter 不能发送，工作耗时那一行不添加 hover／aria-expanded 高亮。
- 消息滚动复用现有 MessageScroller 和显式锚定，不建立平行滚动状态机；补丁维护见 [SDK](sdk-maintenance.md)。

## 对话框

- 底部操作统一 DialogFooter／AlertDialogFooter：普通弹窗有顶部细分隔线，二次确认无分隔线；不加独立背景或负边距。
- 取消／关闭用 ghost，普通默认尺寸，按钮间距 8px。主操作靠右，危险操作 destructive；辅助信息或独立删除入口靠左。
- 只滚动正文并隐藏滚动条，标题和底栏留在滚动区外。通常由 DialogContent 的 p-4 提供留白，p-0 容器须给底栏补 p-4。
- 二次确认用 DialogContent confirmation 或 AlertDialogContent；打开时只聚焦无轮廓的容器，不自动选择取消或危险操作，保留 Tab 导航和关闭后焦点恢复。

## 输入框

- `components/ui/input-surface.ts` 是统一表面，基准为添加供应商搜索框：glass 使用 glass-prompt-foreground/6 填充、glass-border；solid 使用 input/30 填充和边框。
- Input、Textarea、InputGroup 共用，业务仅改尺寸／布局；亮暗模式不再追加另一套默认背景。组内控件透明，由外框绘制一次背景和禁用透明度。
- 正常聚焦不添加主题色边框或光晕，错误态保留。占位文字由 inputPlaceholder 统一：glass 中性前景色 75%，solid 使用 foreground，亮暗色板均检查至少 4.5:1。
- 聊天输入的 solid 使用独立 composer-input-background，默认匹配公共填充，不改变阅读卡片 composer-background。浏览器评论通过计算后的 input／inputBorder／inputPlaceholder 传入 guest，不能传未解析的 var() 或继承网页样式。

## 主题契约

- 色板放在 `themes/theme-<name>.css`：light 用 `html[data-palette='<name>']`，dark 用 `html.dark[data-palette='<name>']`，每个 selector 定义相同的完整语义契约。
- `styles.css` 只注册 Tailwind token，不把某套基础色板硬映射成角色；字面颜色只放色板 selector，不进业务组件或通用 .dark 覆盖。
- 使用 shadcn 的 background／foreground、card、popover、primary、secondary、muted、accent、destructive 及对应前景色，另有 border／input／ring／sidebar-*。基础色名不是组件 API。
- chat-background、composer-background、composer-input-background、user-message-background／user-message-foreground 独立可配，不把消息绑定到主按钮颜色；input 用于控件边框／半透明填充，不能直接充当聊天编辑器的背景角色。
- 页面、侧栏、卡片、聊天没有固定明度顺序，各色板自行建立可读层次。菜单 hover／键盘选择用 accent，不用与 popover 同底的 muted。
- link、selection-background／selection-foreground、success、warning、info、destructive-background、各状态背景对和 chart-1…7 与 primary 独立。
- 代码容器使用 code-background／code-foreground／code-border，高亮交给 Shiki；dot-base 只控制装饰性活动点。
- 普通文字与按钮标签对实际背景至少 4.5:1，大字和必要非文字指示至少 3:1；装饰色可例外，但一旦用于文字仍需检查。
- 验证两套亮暗模式的正文、说明、按钮、输入、弹层和选中态，不只看色卡。

## Glass 合成边界

- glass 磨砂来自网页下面的原生材质（macOS vibrancy、Windows acrylic）。不要用 backdrop-filter 模糊透明窗口中的浮层／卡片／按钮，使用填充透明度、边缘高光和阴影表达层次；solid 可用 solid: 前缀保留模糊。
- Chromium 的透明窗口 backdrop-filter 会把模糊结果叠在未模糊原内容上，甚至读回上一帧导致半截变色，参见 [Electron 问题](https://github.com/electron/electron/issues/19765) 与 [Chromium 问题](https://issues.chromium.org/issues/380416865)。
- glass 对话框用 styles.css 的 :has() 给应用根 `[data-modal-blur-root]` 加 filter:blur(8px)，弹窗 portal 到 body 保持清晰；不要复用嵌套的 data-app-surface，否则重复模糊。
- 原生网页不能靠 DOM z-index、overflow 或 filter 遮挡／裁剪，必须走 [浏览器](browser.md) 的视图隐藏、截帧交接和原生裁剪。
