/** Main-process Pig Bot domain exports. */
export { BotService, botService, notifyBotUserPromptInSessionIfActive, shutdownBotService } from './service'
export { BotStore } from './store'
export { BotNoticeQueue } from './notice-queue'
export { BotTaskManager } from './task-manager'
export { BotDispatcher } from './dispatcher'
export { createBotExtension } from './tools'
export { NonGitWriteMutex, collectWorkspaceReceipt, inspectWorktreeSafety } from './worktree-policy'
export { stripHiddenBotTags, projectTimelineItemToPeek, resolveBotAttachments } from './projection'
