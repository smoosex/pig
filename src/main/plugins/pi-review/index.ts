/**
 * Code Review Extension (inspired by Codex's review feature)
 *
 * Provides a `/review` command that prompts the agent to review code changes.
 * Supports multiple review modes:
 * - Review a GitHub pull request (checks out the PR locally)
 * - Review against a base branch (PR style)
 * - Review uncommitted changes
 * - Review a specific commit
 * - Shared custom review instructions (applied to all review modes when configured)
 *
 * Usage:
 * - `/review` - show interactive selector
 * - `/review pr 123` - review PR #123 (checks out locally)
 * - `/review pr https://github.com/owner/repo/pull/123` - review PR from URL
 * - `/review uncommitted` - review uncommitted changes directly
 * - `/review branch main` - review against main branch
 * - `/review commit abc123` - review specific commit
 * - `/review folder src docs` - review specific folders/files (snapshot, not diff)
 * - `/review` selector includes Add/Remove custom review instructions (applies to all modes)
 * - `/review --extra "focus on performance regressions"` - add extra review instruction (works with any mode)
 *
 * Project-specific review guidelines:
 * - If a REVIEW_GUIDELINES.md file exists in the same directory as .pi,
 *   its contents are appended to the review prompt.
 *
 * Note: PR review requires a clean working tree (no uncommitted changes to tracked files).
 *
 * Pig owns the review command panel, notifications, and session review indicator.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { reviewUI } from "../pig-ui.js";
import path from "node:path";
import { promises as fs } from "node:fs";

// Pi caches extension modules per cwd, so every session in the same worktree shares this module.
// All cross-command state is keyed by session id so sessions cannot inherit each other's review.
const reviewOriginIds = new Map<string, string>();
const endReviewInProgress = new Set<string>();
const reviewCustomInstructions = new Map<string, string>();

function getReviewOriginId(ctx: ExtensionContext): string | undefined {
	return reviewOriginIds.get(ctx.sessionManager.getSessionId());
}

function setReviewOriginId(ctx: ExtensionContext, originId: string | undefined): void {
	const sessionId = ctx.sessionManager.getSessionId();
	if (originId === undefined) {
		reviewOriginIds.delete(sessionId);
	} else {
		reviewOriginIds.set(sessionId, originId);
	}
}

function getCustomReviewInstructions(ctx: ExtensionContext): string | undefined {
	return reviewCustomInstructions.get(ctx.sessionManager.getSessionId());
}

function setCustomReviewInstructions(ctx: ExtensionContext, instructions: string | undefined): void {
	const sessionId = ctx.sessionManager.getSessionId();
	if (instructions) {
		reviewCustomInstructions.set(sessionId, instructions);
	} else {
		reviewCustomInstructions.delete(sessionId);
	}
}

const REVIEW_STATE_TYPE = "review-session";
const REVIEW_ANCHOR_TYPE = "review-anchor";
const REVIEW_SETTINGS_TYPE = "review-settings";
const GH_SETUP_INSTRUCTIONS =
	"Install GitHub CLI (`gh`) from https://cli.github.com/ (macOS: `brew install gh`), then sign in with `gh auth login` and verify with `gh auth status`.";
const PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE =
	"Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.";

type ReviewSessionState = {
	active: boolean;
	originId?: string;
};

type ReviewSettingsState = {
	customInstructions?: string;
};

function setReviewIndicator(ctx: ExtensionContext, active: boolean) {
	reviewUI(ctx).setActive(active);
}

function getReviewState(ctx: ExtensionContext): ReviewSessionState | undefined {
	let state: ReviewSessionState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === REVIEW_STATE_TYPE) {
			state = entry.data as ReviewSessionState | undefined;
		}
	}

	return state;
}

function applyReviewState(ctx: ExtensionContext) {
	const state = getReviewState(ctx);

	if (state?.active && state.originId) {
		setReviewOriginId(ctx, state.originId);
		setReviewIndicator(ctx, true);
		return;
	}

	setReviewOriginId(ctx, undefined);
	setReviewIndicator(ctx, false);
}

function getReviewSettings(ctx: ExtensionContext): ReviewSettingsState {
	let state: ReviewSettingsState | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === REVIEW_SETTINGS_TYPE) {
			state = entry.data as ReviewSettingsState | undefined;
		}
	}

	return {
		customInstructions: state?.customInstructions?.trim() || undefined,
	};
}

function applyReviewSettings(ctx: ExtensionContext) {
	const state = getReviewSettings(ctx);
	setCustomReviewInstructions(ctx, state.customInstructions?.trim() || undefined);
}

// Review target types (matching Codex's approach)
type ReviewTarget =
	| { type: "uncommitted" }
	| { type: "baseBranch"; branch: string }
	| { type: "commit"; sha: string; title?: string }
	| { type: "pullRequest"; prNumber: number; baseBranch: string; title: string }
	| { type: "folder"; paths: string[] };

// Prompts (adapted from Codex)
const UNCOMMITTED_PROMPT =
	"Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.";

const BASE_BRANCH_PROMPT_WITH_MERGE_BASE =
	"Review the code changes against the base branch '{baseBranch}'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes relative to {baseBranch}. Provide prioritized, actionable findings.";

const BASE_BRANCH_PROMPT_FALLBACK =
	"Review the code changes against the base branch '{branch}'. Start by finding the merge diff between the current branch and {branch}'s upstream e.g. (`git merge-base HEAD \"$(git rev-parse --abbrev-ref \"{branch}@{upstream}\")\"`), then run `git diff` against that SHA to see what changes we would merge into the {branch} branch. Provide prioritized, actionable findings.";

const COMMIT_PROMPT_WITH_TITLE =
	'Review the code changes introduced by commit {sha} ("{title}"). Provide prioritized, actionable findings.';

const COMMIT_PROMPT = "Review the code changes introduced by commit {sha}. Provide prioritized, actionable findings.";

const PULL_REQUEST_PROMPT =
	'Review pull request #{prNumber} ("{title}") against the base branch \'{baseBranch}\'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes that would be merged. Provide prioritized, actionable findings.';

const PULL_REQUEST_PROMPT_FALLBACK =
	'Review pull request #{prNumber} ("{title}") against the base branch \'{baseBranch}\'. Start by finding the merge base between the current branch and {baseBranch} (e.g., `git merge-base HEAD {baseBranch}`), then run `git diff` against that SHA to see the changes that would be merged. Provide prioritized, actionable findings.';

const FOLDER_REVIEW_PROMPT =
	"Review the code in the following paths: {paths}. This is a snapshot review (not a diff). Read the files directly in these paths and provide prioritized, actionable findings.";

// The detailed review rubric (adapted from Codex's review_prompt.md)
const REVIEW_RUBRIC = `# Review Guidelines

You are acting as a code reviewer for a proposed code change made by another engineer.

Below are default guidelines for determining what to flag. These are not the final word — if you encounter more specific guidelines elsewhere (in a developer message, user message, file, or project review guidelines appended below), those override these general instructions.

## Determining what to flag

Flag issues that:
1. Meaningfully impact the accuracy, performance, security, or maintainability of the code.
2. Are discrete and actionable (not general issues or multiple combined issues).
3. Don't demand rigor inconsistent with the rest of the codebase.
4. Were introduced in the changes being reviewed (not pre-existing bugs).
5. The author would likely fix if aware of them.
6. Don't rely on unstated assumptions about the codebase or author's intent.
7. Have provable impact on other parts of the code — it is not enough to speculate that a change may disrupt another part, you must identify the parts that are provably affected.
8. Are clearly not intentional changes by the author.
9. Be particularly careful with untrusted user input and follow the specific guidelines to review.
10. Treat silent local error recovery (especially parsing/IO/network fallbacks) as high-signal review candidates unless there is explicit boundary-level justification.
11. Violate the clean-code guidelines below.
12. Introduce error handling that conflicts with the fail-fast guidelines below.

## Clean-code guidelines

1. Check whether each newly added function duplicates existing functionality elsewhere in the codebase. Flag actual duplication and identify the existing implementation.
2. Flag one-off helper functions that add indirection without improving clarity or reuse (for example, \`isRecord\` or \`asString\`).
3. Flag abstractions introduced without a concrete need in the reviewed change, including wrappers created only for hypothetical future use.
4. Flag defensive checks or fallback behavior that mask programming errors, especially when callers already guarantee the relevant invariants.

## Untrusted User Input

1. Be careful with open redirects, they must always be checked to only go to trusted domains (?next_page=...)
2. Always flag SQL that is not parametrized
3. In systems with user supplied URL input, http fetches always need to be protected against access to local resources (intercept DNS resolver!)
4. Escape, don't sanitize if you have the option (eg: HTML escaping)

## Comment guidelines

1. Be clear about why the issue is a problem.
2. Communicate severity appropriately - don't exaggerate.
3. Be brief - at most 1 paragraph.
4. Keep code snippets under 3 lines, wrapped in inline code or code blocks.
5. Use \`\`\`suggestion blocks ONLY for concrete replacement code (minimal lines; no commentary inside the block). Preserve the exact leading whitespace of the replaced lines.
6. Explicitly state scenarios/environments where the issue arises.
7. Use a matter-of-fact tone - helpful AI assistant, not accusatory.
8. Write for quick comprehension without close reading.
9. Avoid excessive flattery or unhelpful phrases like "Great job...".

## Review priorities

1. Surface critical non-blocking human callouts (migrations, dependency churn, auth/permissions, compatibility, destructive operations) at the end.
2. Prefer simple, direct solutions over wrappers or abstractions without clear value.
3. Treat back pressure handling as critical to system stability.
4. Apply system-level thinking; flag changes that increase operational risk or on-call wakeups.
5. Ensure that errors are always checked against codes or stable identifiers, never error messages.

## Fail-fast error handling (strict)

When reviewing added or modified error handling, default to fail-fast behavior.

1. Evaluate every new or changed \`try/catch\`: identify what can fail and why local handling is correct at that exact layer.
2. Prefer propagation over local recovery. If the current scope cannot fully recover while preserving correctness, rethrow (optionally with context) instead of returning fallbacks.
3. Flag catch blocks that hide failure signals (e.g. returning \`null\`/\`[]\`/\`false\`, swallowing JSON parse failures, logging-and-continue, or “best effort” silent recovery).
4. JSON parsing/decoding should fail loudly by default. Quiet fallback parsing is only acceptable with an explicit compatibility requirement and clear tested behavior.
5. Boundary handlers (HTTP routes, CLI entrypoints, supervisors) may translate errors, but must not pretend success or silently degrade.
6. If a catch exists only to satisfy lint/style without real handling, treat it as a bug.
7. When uncertain, prefer crashing fast over silent degradation.

## Required human callouts (non-blocking, at the very end)

After findings/verdict, you MUST append this final section:

## Human Reviewer Callouts (Non-Blocking)

Include only applicable callouts (no yes/no lines):

- **This change adds a database migration:** <files/details>
- **This change introduces a new dependency:** <package(s)/details>
- **This change changes a dependency (or the lockfile):** <files/package(s)/details>
- **This change modifies auth/permission behavior:** <what changed and where>
- **This change introduces backwards-incompatible public schema/API/contract changes:** <what changed and where>
- **This change includes irreversible or destructive operations:** <operation and scope>
- **This change adds or removes feature flags:** <feature flags changed> (call out re-use of dormant feature flags!)
- **This change changes configuration defaults:** <config var changed>

Rules for this section:
1. These are informational callouts for the human reviewer, not fix items.
2. Do not include them in Findings unless there is an independent defect.
3. These callouts alone must not change the verdict.
4. Only include callouts that apply to the reviewed change.
5. Keep each emitted callout bold exactly as written.
6. If none apply, write "- (none)".

## Priority levels

Tag each finding with a priority level in the title:
- [P0] - Drop everything to fix. Blocking release/operations. Only for universal issues that do not depend on assumptions about inputs.
- [P1] - Urgent. Should be addressed in the next cycle.
- [P2] - Normal. To be fixed eventually.
- [P3] - Low. Nice to have.

## Output format

Provide your findings in a clear, structured format:
1. List each finding with its priority tag, file location, and explanation.
2. Findings must reference locations that overlap with the actual diff — don't flag pre-existing code.
3. Keep line references as short as possible (avoid ranges over 5-10 lines; pick the most suitable subrange).
4. Provide an overall verdict: "correct" (no blocking issues) or "needs attention" (has blocking issues).
5. Ignore trivial style issues unless they obscure meaning or violate documented standards.
6. Do not generate a full PR fix — only flag issues and optionally provide short suggestion blocks.
7. End with the required "Human Reviewer Callouts (Non-Blocking)" section and all applicable bold callouts (no yes/no).

Output all findings the author would fix if they knew about them. If there are no qualifying findings, explicitly state the code looks good. Don't stop at the first finding - list every qualifying issue. Then append the required non-blocking callouts section.`;

function isFileNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function loadProjectReviewGuidelines(cwd: string): Promise<string | null> {
	let currentDir = path.resolve(cwd);

	while (true) {
		const piDir = path.join(currentDir, ".pi");
		const guidelinesPath = path.join(currentDir, "REVIEW_GUIDELINES.md");

		let piIsDirectory = false;
		try {
			piIsDirectory = (await fs.stat(piDir)).isDirectory();
		} catch (error) {
			// Only a missing .pi means "keep walking up"; anything else (permissions) must surface.
			if (!isFileNotFound(error)) throw error;
		}

		if (piIsDirectory) {
			// A path that exists but is not a regular file (a directory, a fifo) is not review
			// guidelines; only a real file that cannot be read is an error worth surfacing.
			let guidelinesIsFile = false;
			try {
				guidelinesIsFile = (await fs.stat(guidelinesPath)).isFile();
			} catch (error) {
				if (isFileNotFound(error)) return null;
				throw error;
			}
			if (!guidelinesIsFile) return null;

			try {
				const content = await fs.readFile(guidelinesPath, "utf8");
				const trimmed = content.trim();
				return trimmed ? trimmed : null;
			} catch (error) {
				throw new Error(
					`Could not read ${guidelinesPath}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) {
			return null;
		}
		currentDir = parentDir;
	}
}

/**
 * Get the merge base between HEAD and a branch
 */
async function getMergeBase(
	pi: ExtensionAPI,
	branch: string,
): Promise<string | null> {
	try {
		// First try to get the upstream tracking branch
		const { stdout: upstream, code: upstreamCode } = await pi.exec("git", [
			"rev-parse",
			"--abbrev-ref",
			`${branch}@{upstream}`,
		]);

		if (upstreamCode === 0 && upstream.trim()) {
			const { stdout: mergeBase, code } = await pi.exec("git", ["merge-base", "HEAD", upstream.trim()]);
			if (code === 0 && mergeBase.trim()) {
				return mergeBase.trim();
			}
		}

		// Fall back to using the branch directly
		const { stdout: mergeBase, code } = await pi.exec("git", ["merge-base", "HEAD", branch]);
		if (code === 0 && mergeBase.trim()) {
			return mergeBase.trim();
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Get list of local branches
 */
async function getLocalBranches(pi: ExtensionAPI): Promise<string[]> {
	const { stdout, code } = await pi.exec("git", ["branch", "--format=%(refname:short)"]);
	if (code !== 0) return [];
	return stdout
		.trim()
		.split("\n")
		.filter((b) => b.trim());
}

/**
 * Get list of recent commits
 */
async function getRecentCommits(pi: ExtensionAPI, limit: number = 10): Promise<Array<{ sha: string; title: string }>> {
	const { stdout, code } = await pi.exec("git", ["log", `--oneline`, `-n`, `${limit}`]);
	if (code !== 0) return [];

	return stdout
		.trim()
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			const [sha, ...rest] = line.trim().split(" ");
			return { sha, title: rest.join(" ") };
		});
}

/**
 * Check if there are uncommitted changes (staged, unstaged, or untracked)
 */
async function hasUncommittedChanges(pi: ExtensionAPI): Promise<boolean> {
	const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);
	return code === 0 && stdout.trim().length > 0;
}

/**
 * Check if there are changes that would prevent switching branches
 * (staged or unstaged changes to tracked files - untracked files are fine)
 */
async function hasPendingChanges(pi: ExtensionAPI): Promise<boolean> {
	// Check for staged or unstaged changes to tracked files
	const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);
	if (code !== 0) return false;

	// Filter out untracked files (lines starting with ??)
	const lines = stdout.trim().split("\n").filter((line) => line.trim());
	const trackedChanges = lines.filter((line) => !line.startsWith("??"));
	return trackedChanges.length > 0;
}

/**
 * Parse a PR reference (URL or number) and return the PR number
 */
function parsePrReference(ref: string): number | null {
	const trimmed = ref.trim();

	// Try as a number first
	const num = parseInt(trimmed, 10);
	if (!isNaN(num) && num > 0) {
		return num;
	}

	// Try to extract from GitHub URL
	// Formats: https://github.com/owner/repo/pull/123
	//          github.com/owner/repo/pull/123
	const urlMatch = trimmed.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
	if (urlMatch) {
		return parseInt(urlMatch[1], 10);
	}

	return null;
}

/**
 * Get PR information from GitHub CLI
 */
async function getPrInfo(
	pi: ExtensionAPI,
	prNumber: number,
): Promise<{ baseBranch: string; title: string; headBranch: string } | { error: string }> {
	const { stdout, stderr, code } = await pi.exec("gh", [
		"pr", "view", String(prNumber),
		"--json", "baseRefName,title,headRefName",
	]);

	if (code !== 0) {
		return { error: stderr.trim() || stdout.trim() || `gh exited with code ${code}` };
	}

	let data: { baseRefName?: string; title?: string; headRefName?: string };
	try {
		data = JSON.parse(stdout);
	} catch (error) {
		return { error: `could not parse \`gh pr view\` output: ${error instanceof Error ? error.message : String(error)}` };
	}

	if (!data.baseRefName || !data.headRefName) {
		return { error: "`gh pr view` returned no branch information" };
	}

	return {
		baseBranch: data.baseRefName,
		title: data.title ?? "",
		headBranch: data.headRefName,
	};
}

/**
 * Checkout a PR using GitHub CLI
 */
async function checkoutPr(pi: ExtensionAPI, prNumber: number): Promise<{ success: boolean; error?: string }> {
	const { stdout, stderr, code } = await pi.exec("gh", ["pr", "checkout", String(prNumber)]);

	if (code !== 0) {
		return { success: false, error: stderr || stdout || "Failed to checkout PR" };
	}

	return { success: true };
}

/**
 * Get the current branch name
 */
async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
	const { stdout, code } = await pi.exec("git", ["branch", "--show-current"]);
	if (code === 0 && stdout.trim()) {
		return stdout.trim();
	}
	return null;
}

/**
 * Get the default branch (main or master)
 */
async function getDefaultBranch(pi: ExtensionAPI): Promise<string> {
	// Try to get from remote HEAD
	const { stdout, code } = await pi.exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
	if (code === 0 && stdout.trim()) {
		return stdout.trim().replace("origin/", "");
	}

	// Fall back to checking if main or master exists
	const branches = await getLocalBranches(pi);
	if (branches.includes("main")) return "main";
	if (branches.includes("master")) return "master";

	return "main"; // Default fallback
}

/**
 * Build the review prompt based on target
 */
async function buildReviewPrompt(
	pi: ExtensionAPI,
	target: ReviewTarget,
): Promise<string> {
	switch (target.type) {
		case "uncommitted":
			return UNCOMMITTED_PROMPT;

		case "baseBranch": {
			const mergeBase = await getMergeBase(pi, target.branch);
			const basePrompt = mergeBase
				? BASE_BRANCH_PROMPT_WITH_MERGE_BASE.replace(/{baseBranch}/g, target.branch).replace(/{mergeBaseSha}/g, mergeBase)
				: BASE_BRANCH_PROMPT_FALLBACK.replace(/{branch}/g, target.branch);
			return basePrompt;
		}

		case "commit":
			if (target.title) {
				return COMMIT_PROMPT_WITH_TITLE.replace("{sha}", target.sha).replace("{title}", target.title);
			}
			return COMMIT_PROMPT.replace("{sha}", target.sha);

		case "pullRequest": {
			const mergeBase = await getMergeBase(pi, target.baseBranch);
			const basePrompt = mergeBase
				? PULL_REQUEST_PROMPT
						.replace(/{prNumber}/g, String(target.prNumber))
						.replace(/{title}/g, target.title)
						.replace(/{baseBranch}/g, target.baseBranch)
						.replace(/{mergeBaseSha}/g, mergeBase)
				: PULL_REQUEST_PROMPT_FALLBACK
						.replace(/{prNumber}/g, String(target.prNumber))
						.replace(/{title}/g, target.title)
						.replace(/{baseBranch}/g, target.baseBranch);
			return basePrompt;
		}

		case "folder":
			return FOLDER_REVIEW_PROMPT.replace("{paths}", target.paths.join(", "));
	}
}

/**
 * Get user-facing hint for the review target
 */
function getUserFacingHint(target: ReviewTarget): string {
	switch (target.type) {
		case "uncommitted":
			return "current changes";
		case "baseBranch":
			return `changes against '${target.branch}'`;
		case "commit": {
			const shortSha = target.sha.slice(0, 7);
			return target.title ? `commit ${shortSha}: ${target.title}` : `commit ${shortSha}`;
		}

		case "pullRequest": {
			const shortTitle = target.title.length > 30 ? target.title.slice(0, 27) + "..." : target.title;
			return `PR #${target.prNumber}: ${shortTitle}`;
		}

		case "folder": {
			const joined = target.paths.join(", ");
			return joined.length > 40 ? `folders: ${joined.slice(0, 37)}...` : `folders: ${joined}`;
		}
	}
}

// Review preset options for the selector (keep this order stable)
const REVIEW_PRESETS = [
	{ value: "uncommitted", label: "Review uncommitted changes", description: "" },
	{ value: "baseBranch", label: "Review against a base branch", description: "(local)" },
	{ value: "commit", label: "Review a commit", description: "" },
	{ value: "pullRequest", label: "Review a pull request", description: "(GitHub PR)" },
	{ value: "folder", label: "Review a folder (or more)", description: "(snapshot, not diff)" },
] as const;

const TOGGLE_CUSTOM_INSTRUCTIONS_VALUE = "toggleCustomInstructions" as const;
type ReviewPresetValue =
	| (typeof REVIEW_PRESETS)[number]["value"]
	| typeof TOGGLE_CUSTOM_INSTRUCTIONS_VALUE
	| "removeInstructions";

export default function reviewExtension(pi: ExtensionAPI) {
	function persistReviewSettings(ctx: ExtensionContext) {
		pi.appendEntry(REVIEW_SETTINGS_TYPE, {
			customInstructions: getCustomReviewInstructions(ctx),
		});
	}

	function updateReviewCustomInstructions(ctx: ExtensionContext, instructions: string | undefined) {
		setCustomReviewInstructions(ctx, instructions?.trim() || undefined);
		persistReviewSettings(ctx);
	}

	function applyAllReviewState(ctx: ExtensionContext) {
		applyReviewSettings(ctx);
		applyReviewState(ctx);
	}

	async function ensureGithubCliReady(ctx: ExtensionContext): Promise<boolean> {
		const ghVersion = await pi.exec("gh", ["--version"]);
		if (ghVersion.code !== 0) {
			reviewUI(ctx).notify(`PR review requires GitHub CLI (\`gh\`). ${GH_SETUP_INSTRUCTIONS}`, "error");
			return false;
		}

		const ghAuthStatus = await pi.exec("gh", ["auth", "status"]);
		if (ghAuthStatus.code !== 0) {
			reviewUI(ctx).notify(
				"GitHub CLI is installed, but you're not signed in. Run `gh auth login`, then verify with `gh auth status`.",
				"error",
			);
			return false;
		}

		return true;
	}

	async function resolvePullRequestTarget(
		ctx: ExtensionContext,
		ref: string,
		options: { skipInitialPendingChangesCheck?: boolean } = {},
	): Promise<ReviewTarget | null> {
		if (!(await ensureGithubCliReady(ctx))) {
			return null;
		}

		if (!options.skipInitialPendingChangesCheck && (await hasPendingChanges(pi))) {
			reviewUI(ctx).notify(PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE, "error");
			return null;
		}

		const prNumber = parsePrReference(ref);
		if (!prNumber) {
			reviewUI(ctx).notify("Invalid PR reference. Enter a number or GitHub PR URL.", "error");
			return null;
		}

		reviewUI(ctx).notify(`Fetching PR #${prNumber} info...`, "info");
		const prInfo = await getPrInfo(pi, prNumber);

		if ("error" in prInfo) {
			reviewUI(ctx).notify(
				`Could not fetch PR #${prNumber}: ${prInfo.error}. Make sure it exists and your GitHub auth has access (check with \`gh auth status\`).`,
				"error",
			);
			return null;
		}

		// Re-check right before checkout to avoid switching branches with newly introduced changes.
		if (await hasPendingChanges(pi)) {
			reviewUI(ctx).notify(PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE, "error");
			return null;
		}

		reviewUI(ctx).notify(`Checking out PR #${prNumber}...`, "info");
		const checkoutResult = await checkoutPr(pi, prNumber);

		if (!checkoutResult.success) {
			reviewUI(ctx).notify(`Failed to checkout PR: ${checkoutResult.error}`, "error");
			return null;
		}

		reviewUI(ctx).notify(`Checked out PR #${prNumber} (${prInfo.headBranch})`, "info");

		return {
			type: "pullRequest",
			prNumber,
			baseBranch: prInfo.baseBranch,
			title: prInfo.title,
		};
	}

	pi.on("session_start", (_event, ctx) => {
		applyAllReviewState(ctx);
	});


	pi.on("session_tree", (_event, ctx) => {
		applyAllReviewState(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		reviewOriginIds.delete(sessionId);
		reviewCustomInstructions.delete(sessionId);
		endReviewInProgress.delete(sessionId);
	});

	/**
	 * Determine the smart default review type based on git state
	 */
	async function getSmartDefault(): Promise<"uncommitted" | "baseBranch" | "commit"> {
		// Priority 1: If there are uncommitted changes, default to reviewing them
		if (await hasUncommittedChanges(pi)) {
			return "uncommitted";
		}

		// Priority 2: If on a feature branch (not the default branch), default to PR-style review
		const currentBranch = await getCurrentBranch(pi);
		const defaultBranch = await getDefaultBranch(pi);
		if (currentBranch && currentBranch !== defaultBranch) {
			return "baseBranch";
		}

		// Priority 3: Default to reviewing a specific commit
		return "commit";
	}

	/**
	 * Show the review preset selector
	 */
	async function showReviewSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		const smartDefault = await getSmartDefault();
		const presetItems = REVIEW_PRESETS
			.map((preset) => ({
				value: preset.value as ReviewPresetValue,
				label: preset.label,
				description: preset.description,
				recommended: preset.value === smartDefault,
			}))
			.sort((a, b) => a.value === smartDefault ? -1 : b.value === smartDefault ? 1 : 0);

		while (true) {
			const customInstructionsLabel = getCustomReviewInstructions(ctx)
				? "Remove custom review instructions (currently set)"
				: "Add custom review instructions (applies to all review modes)";
			const items = [
				...presetItems,
				{ value: getCustomReviewInstructions(ctx) ? "removeInstructions" : TOGGLE_CUSTOM_INSTRUCTIONS_VALUE, label: customInstructionsLabel },
			];

			const choice = await reviewUI(ctx).choose("preset", items);
			if (choice === undefined) return null;
			const result = choice as ReviewPresetValue;

			if (result === TOGGLE_CUSTOM_INSTRUCTIONS_VALUE || result === "removeInstructions") {
				if (getCustomReviewInstructions(ctx)) {
					updateReviewCustomInstructions(ctx, undefined);
					reviewUI(ctx).notify("Custom review instructions removed", "info");
					continue;
				}

				const customInstructions = await reviewUI(ctx).edit("instructions", "");

				if (!customInstructions?.trim()) {
					reviewUI(ctx).notify("Custom review instructions not changed", "info");
					continue;
				}

				updateReviewCustomInstructions(ctx, customInstructions);
				reviewUI(ctx).notify("Custom review instructions saved", "info");
				continue;
			}

			// Handle each preset type
			switch (result) {
				case "uncommitted":
					return { type: "uncommitted" };

				case "baseBranch": {
					const target = await showBranchSelector(ctx);
					if (target) return target;
					break;
				}

				case "commit": {
					const target = await showCommitSelector(ctx);
					if (target) return target;
					break;
				}

				case "folder": {
					const target = await showFolderInput(ctx);
					if (target) return target;
					break;
				}

				case "pullRequest": {
					const target = await showPrInput(ctx);
					if (target) return target;
					break;
				}

				default:
					return null;
			}
		}
	}

	/**
	 * Show branch selector for base branch review
	 */
	async function showBranchSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		const branches = await getLocalBranches(pi);
		const currentBranch = await getCurrentBranch(pi);
		const defaultBranch = await getDefaultBranch(pi);

		// Never offer the current branch as a base branch (reviewing against itself is meaningless).
		const candidateBranches = currentBranch ? branches.filter((b) => b !== currentBranch) : branches;

		if (candidateBranches.length === 0) {
			reviewUI(ctx).notify(
				currentBranch ? `No other branches found (current branch: ${currentBranch})` : "No branches found",
				"error",
			);
			return null;
		}

		// Sort branches with default branch first
		const sortedBranches = candidateBranches.sort((a, b) => {
			if (a === defaultBranch) return -1;
			if (b === defaultBranch) return 1;
			return a.localeCompare(b);
		});

		const choice = await reviewUI(ctx).choose("branch", sortedBranches.map((branch) => ({
			value: branch, label: branch, recommended: branch === defaultBranch,
		})));
		if (choice === undefined) return null;
		const branch = sortedBranches.find((branch) => branch === choice);
		if (!branch) return null;
		return { type: "baseBranch", branch };
	}

	/**
	 * Show commit selector
	 */
	async function showCommitSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		const commits = await getRecentCommits(pi, 20);

		if (commits.length === 0) {
			reviewUI(ctx).notify("No commits found", "error");
			return null;
		}

		const choice = await reviewUI(ctx).choose("commit", commits.map((commit) => ({
			value: commit.sha, label: commit.title, description: commit.sha.slice(0, 7),
		})));
		if (choice === undefined) return null;
		const commit = commits.find((commit) => commit.sha === choice);
		if (!commit) return null;
		return { type: "commit", sha: commit.sha, title: commit.title };
	}

	function parseReviewPaths(value: string): string[] {
		return value
			.split(/\s+/)
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}

	/**
	 * Show folder input
	 */
	async function showFolderInput(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		const result = await reviewUI(ctx).edit("folders", ".");

		if (!result?.trim()) return null;
		const paths = parseReviewPaths(result);
		if (paths.length === 0) return null;

		return { type: "folder", paths };
	}

	/**
	 * Show PR input and handle checkout
	 */
	async function showPrInput(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		// First check for pending changes that would prevent branch switching
		if (await hasPendingChanges(pi)) {
			reviewUI(ctx).notify(PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE, "error");
			return null;
		}

		// Get PR reference from user
		const prRef = await reviewUI(ctx).edit("pr", "");

		if (!prRef?.trim()) return null;

		return await resolvePullRequestTarget(ctx, prRef, { skipInitialPendingChangesCheck: true });
	}

	/**
	 * Execute the review
	 */
	async function executeReview(
		ctx: ExtensionCommandContext,
		target: ReviewTarget,
		useFreshSession: boolean,
		options?: { extraInstruction?: string },
	): Promise<boolean> {
		// Check if we're already in a review
		if (getReviewOriginId(ctx)) {
			reviewUI(ctx).notify("Already in a review. Use /end-review to finish first.", "warning");
			return false;
		}

		// Prepare everything that can fail before touching review state, so a failure leaves the
		// session (branch, anchor entry, review indicator) exactly as it was.
		const prompt = await buildReviewPrompt(pi, target);
		const hint = getUserFacingHint(target);
		const projectGuidelines = await loadProjectReviewGuidelines(ctx.cwd);

		// Handle fresh session mode
		if (useFreshSession) {
			// Store current position (where we'll return to).
			// In an empty session there is no leaf yet, so create a lightweight anchor first.
			let originId = ctx.sessionManager.getLeafId() ?? undefined;
			if (!originId) {
				pi.appendEntry(REVIEW_ANCHOR_TYPE, { createdAt: new Date().toISOString() });
				originId = ctx.sessionManager.getLeafId() ?? undefined;
			}
			if (!originId) {
				reviewUI(ctx).notify("Failed to determine review origin.", "error");
				return false;
			}
			setReviewOriginId(ctx, originId);

			// Keep a local copy so session_tree events during navigation don't wipe it
			const lockedOriginId = originId;

			// Find the first user message in the session.
			// If none exists (e.g. brand-new session), we'll stay on the current leaf.
			const entries = ctx.sessionManager.getEntries();
			const firstUserMessage = entries.find(
				(e) => e.type === "message" && e.message.role === "user",
			);

			if (firstUserMessage) {
				// Navigate to first user message to create a new branch from that point
				// Label it as "code-review" so it's visible in the tree
				try {
					const result = await ctx.navigateTree(firstUserMessage.id, { summarize: false, label: "code-review" });
					if (result.cancelled) {
						setReviewOriginId(ctx, undefined);
						return false;
					}
				} catch (error) {
					// Clean up state if navigation fails
					setReviewOriginId(ctx, undefined);
					reviewUI(ctx).notify(`Failed to start review: ${error instanceof Error ? error.message : String(error)}`, "error");
					return false;
				}
			}

			// Restore origin after navigation events (session_tree can reset it)
			setReviewOriginId(ctx, lockedOriginId);

			setReviewIndicator(ctx, true);

			// Persist review state so tree navigation can restore/reset it
			pi.appendEntry(REVIEW_STATE_TYPE, { active: true, originId: lockedOriginId });
		}

		let fullPrompt = `${REVIEW_RUBRIC}\n\n---\n\nPlease perform a code review with the following focus:\n\n${prompt}`;

		const customInstructions = getCustomReviewInstructions(ctx);
		if (customInstructions) {
			fullPrompt += `\n\nShared custom review instructions (applies to all reviews):\n\n${customInstructions}`;
		}

		if (options?.extraInstruction?.trim()) {
			fullPrompt += `\n\nAdditional user-provided review instruction:\n\n${options.extraInstruction.trim()}`;
		}

		if (projectGuidelines) {
			fullPrompt += `\n\nThis project has additional instructions for code reviews:\n\n${projectGuidelines}`;
		}

		const modeHint = useFreshSession ? " (fresh session)" : "";
		reviewUI(ctx).notify(`Starting review: ${hint}${modeHint}`, "info");

		// Send as a user message that triggers a turn
		pi.sendUserMessage(fullPrompt);
		return true;
	}

	/**
	 * Parse command arguments for direct invocation
	 * Returns the target or a special marker for PR that needs async handling
	 */
	type ParsedReviewArgs = {
		target: ReviewTarget | { type: "pr"; ref: string } | null;
		extraInstruction?: string;
		error?: string;
	};

	function tokenizeArgs(value: string): string[] {
		const tokens: string[] = [];
		let current = "";
		let quote: '"' | "'" | null = null;

		for (let i = 0; i < value.length; i++) {
			const char = value[i];

			if (quote) {
				if (char === "\\" && i + 1 < value.length) {
					current += value[i + 1];
					i += 1;
					continue;
				}
				if (char === quote) {
					quote = null;
					continue;
				}
				current += char;
				continue;
			}

			if (char === '"' || char === "'") {
				quote = char;
				continue;
			}

			if (/\s/.test(char)) {
				if (current.length > 0) {
					tokens.push(current);
					current = "";
				}
				continue;
			}

			current += char;
		}

		if (current.length > 0) {
			tokens.push(current);
		}

		return tokens;
	}

	function parseArgs(args: string | undefined): ParsedReviewArgs {
		if (!args?.trim()) return { target: null };

		const rawParts = tokenizeArgs(args.trim());
		const parts: string[] = [];
		let extraInstruction: string | undefined;

		for (let i = 0; i < rawParts.length; i++) {
			const part = rawParts[i];
			if (part === "--extra") {
				const next = rawParts[i + 1];
				if (!next) {
					return { target: null, error: "Missing value for --extra" };
				}
				extraInstruction = next;
				i += 1;
				continue;
			}

			if (part.startsWith("--extra=")) {
				extraInstruction = part.slice("--extra=".length);
				continue;
			}

			parts.push(part);
		}

		if (parts.length === 0) {
			return { target: null, extraInstruction };
		}

		const subcommand = parts[0]?.toLowerCase();

		switch (subcommand) {
			case "uncommitted":
				return { target: { type: "uncommitted" }, extraInstruction };

			case "branch": {
				const branch = parts[1];
				if (!branch) return { target: null, extraInstruction };
				return { target: { type: "baseBranch", branch }, extraInstruction };
			}

			case "commit": {
				const sha = parts[1];
				if (!sha) return { target: null, extraInstruction };
				const title = parts.slice(2).join(" ") || undefined;
				return { target: { type: "commit", sha, title }, extraInstruction };
			}


			case "folder": {
				const paths = parseReviewPaths(parts.slice(1).join(" "));
				if (paths.length === 0) return { target: null, extraInstruction };
				return { target: { type: "folder", paths }, extraInstruction };
			}

			case "pr": {
				const ref = parts[1];
				if (!ref) return { target: null, extraInstruction };
				return { target: { type: "pr", ref }, extraInstruction };
			}

			default:
				return { target: null, extraInstruction };
		}
	}

	// Register the /review command
	pi.registerCommand("review", {
		description: "Review code changes (PR, uncommitted, branch, commit, or folder)",
		handler: async (args, ctx) => {
			if (!reviewUI(ctx).available) return;

			// Check if we're already in a review
			if (getReviewOriginId(ctx)) {
				reviewUI(ctx).notify("Already in a review. Use /end-review to finish first.", "warning");
				return;
			}

			// Check if we're in a git repository
			const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
			if (code !== 0) {
				reviewUI(ctx).notify("Not a git repository", "error");
				return;
			}

			// Try to parse direct arguments
			let target: ReviewTarget | null = null;
			let fromSelector = false;
			let extraInstruction: string | undefined;
			const parsed = parseArgs(args);
			if (parsed.error) {
				reviewUI(ctx).notify(parsed.error, "error");
				return;
			}
			extraInstruction = parsed.extraInstruction?.trim() || undefined;

			if (parsed.target) {
				if (parsed.target.type === "pr") {
					// Handle PR checkout (async operation)
					target = await resolvePullRequestTarget(ctx, parsed.target.ref);
					if (!target) {
						reviewUI(ctx).notify("PR review failed. Returning to review menu.", "warning");
					}
				} else {
					target = parsed.target;
				}
			}

			// If no args or invalid args, show selector
			if (!target) {
				fromSelector = true;
			}

			while (true) {
				if (!target && fromSelector) {
					target = await showReviewSelector(ctx);
				}

				if (!target) {
					reviewUI(ctx).notify("Review cancelled", "info");
					return;
				}

				// Determine if we should use fresh session mode
				// Check if this is a new session (no messages yet)
				const entries = ctx.sessionManager.getEntries();
				const messageCount = entries.filter((e) => e.type === "message").length;

				// In an empty session, default to fresh review mode so /end-review works consistently.
				let useFreshSession = messageCount === 0;

				if (messageCount > 0) {
					// Existing session - ask user which mode they want
					const choice = await reviewUI(ctx).choose("start", [
						{ value: "emptyBranch", label: "Empty branch" },
						{ value: "currentSession", label: "Current session" },
					]);

					if (choice === undefined) {
						if (fromSelector) {
							target = null;
							continue;
						}
						reviewUI(ctx).notify("Review cancelled", "info");
						return;
					}

					useFreshSession = choice === "emptyBranch";
				}

				await executeReview(ctx, target, useFreshSession, { extraInstruction });
				return;
			}
		},
	});

	// Custom prompt for review summaries - focuses on preserving actionable findings
	const REVIEW_SUMMARY_PROMPT = `We are leaving a code-review branch and returning to the main coding branch.
Create a structured handoff that can be used immediately to implement fixes.

You MUST summarize the review that happened in this branch so findings can be acted on.
Do not omit findings: include every actionable issue that was identified.

Required sections (in order):

## Review Scope
- What was reviewed (files/paths, changes, and scope)

## Verdict
- "correct" or "needs attention"

## Findings
For EACH finding, include:
- Priority tag ([P0]..[P3]) and short title
- File location (\`path/to/file.ext:line\`)
- Why it matters (brief)
- What should change (brief, actionable)

## Fix Queue
1. Ordered implementation checklist (highest priority first)

## Constraints & Preferences
- Any constraints or preferences mentioned during review
- Or "(none)"

## Human Reviewer Callouts (Non-Blocking)
Include only applicable callouts (no yes/no lines):
- **This change adds a database migration:** <files/details>
- **This change introduces a new dependency:** <package(s)/details>
- **This change changes a dependency (or the lockfile):** <files/package(s)/details>
- **This change modifies auth/permission behavior:** <what changed and where>
- **This change introduces backwards-incompatible public schema/API/contract changes:** <what changed and where>
- **This change includes irreversible or destructive operations:** <operation and scope>

If none apply, write "- (none)".

These are informational callouts for humans and are not fix items by themselves.

Preserve exact file paths, function names, and error messages where available.`;

	const REVIEW_FIX_FINDINGS_PROMPT = `Use the latest review summary in this session and implement the review findings now.

Instructions:
1. Treat the summary's Findings/Fix Queue as a checklist.
2. Fix in priority order: P0, P1, then P2 (include P3 if quick and safe).
3. If a finding is invalid/already fixed/not possible right now, briefly explain why and continue.
4. Treat "Human Reviewer Callouts (Non-Blocking)" as informational only; do not convert them into fix tasks unless there is a separate explicit finding.
5. Follow fail-fast error handling: do not add local catch/fallback recovery unless this scope is an explicit boundary that can safely translate the failure.
6. If you add or keep a \`try/catch\`, explain the expected failure mode and either rethrow with context or return a boundary-safe error response.
7. JSON parsing/decoding should fail loudly by default; avoid silent fallback parsing.
8. Run relevant tests/checks for touched code where practical.
9. End with: fixed items, deferred/skipped items (with reasons), and verification results.`;

	type EndReviewAction = "returnOnly" | "returnAndFix" | "returnAndSummarize";
	type EndReviewActionResult = "ok" | "cancelled" | "error";
	type EndReviewActionOptions = {
		notifySuccess?: boolean;
	};

	function getActiveReviewOrigin(ctx: ExtensionContext): string | undefined {
		const originId = getReviewOriginId(ctx);
		if (originId) {
			return originId;
		}

		const state = getReviewState(ctx);
		if (state?.active && state.originId) {
			setReviewOriginId(ctx, state.originId);
			return state.originId;
		}

		if (state?.active) {
			setReviewIndicator(ctx, false);
			pi.appendEntry(REVIEW_STATE_TYPE, { active: false });
			reviewUI(ctx).notify("Review state was missing origin info; cleared review status.", "warning");
		}

		return undefined;
	}

	function clearReviewState(ctx: ExtensionContext) {
		setReviewIndicator(ctx, false);
		setReviewOriginId(ctx, undefined);
		pi.appendEntry(REVIEW_STATE_TYPE, { active: false });
	}

	async function navigateWithSummary(
		ctx: ExtensionCommandContext,
		originId: string,
	): Promise<{ cancelled: boolean; error?: string } | null> {
		reviewUI(ctx).notify("Returning and summarizing review branch...", "info");

		try {
			return await ctx.navigateTree(originId, {
				summarize: true,
				customInstructions: REVIEW_SUMMARY_PROMPT,
				replaceInstructions: true,
			});
		} catch (error) {
			return { cancelled: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async function executeEndReviewAction(
		ctx: ExtensionCommandContext,
		action: EndReviewAction,
		options: EndReviewActionOptions = {},
	): Promise<EndReviewActionResult> {
		const originId = getActiveReviewOrigin(ctx);
		if (!originId) {
			if (!getReviewState(ctx)?.active) {
				reviewUI(ctx).notify("Not in a review branch (use /review first, or review was started in current session mode)", "info");
			}
			return "error";
		}

		const notifySuccess = options.notifySuccess ?? true;

		if (action === "returnOnly") {
			try {
				const result = await ctx.navigateTree(originId, { summarize: false });
				if (result.cancelled) {
					reviewUI(ctx).notify("Navigation cancelled. Use /end-review to try again.", "info");
					return "cancelled";
				}
			} catch (error) {
				reviewUI(ctx).notify(`Failed to return: ${error instanceof Error ? error.message : String(error)}`, "error");
				return "error";
			}

			clearReviewState(ctx);
			if (notifySuccess) {
				reviewUI(ctx).notify("Review complete! Returned to original position.", "info");
			}
			return "ok";
		}

		const summaryResult = await navigateWithSummary(ctx, originId);
		if (summaryResult === null) {
			reviewUI(ctx).notify("Summarization cancelled. Use /end-review to try again.", "info");
			return "cancelled";
		}

		if (summaryResult.error) {
			reviewUI(ctx).notify(`Summarization failed: ${summaryResult.error}`, "error");
			return "error";
		}

		if (summaryResult.cancelled) {
			reviewUI(ctx).notify("Navigation cancelled. Use /end-review to try again.", "info");
			return "cancelled";
		}

		clearReviewState(ctx);

		if (action === "returnAndSummarize") {
			if (notifySuccess) {
				reviewUI(ctx).notify("Review complete! Returned and summarized.", "info");
			}
			return "ok";
		}

		pi.sendUserMessage(REVIEW_FIX_FINDINGS_PROMPT, { deliverAs: "followUp" });
		if (notifySuccess) {
			reviewUI(ctx).notify("Review complete! Returned and queued a follow-up to fix findings.", "info");
		}
		return "ok";
	}

	async function runEndReview(ctx: ExtensionCommandContext): Promise<void> {
		if (!reviewUI(ctx).available) return;


		if (endReviewInProgress.has(ctx.sessionManager.getSessionId())) {
			reviewUI(ctx).notify("/end-review is already running", "info");
			return;
		}

		const sessionId = ctx.sessionManager.getSessionId();
		endReviewInProgress.add(sessionId);
		try {
			reviewUI(ctx).setReturning(true);
			const choice = await reviewUI(ctx).choose("finish", [
				{ value: "returnOnly", label: "Return only" },
				{ value: "returnAndFix", label: "Return and fix findings" },
				{ value: "returnAndSummarize", label: "Return and summarize" },
			]);

			if (choice === undefined) {
				reviewUI(ctx).notify("Cancelled. Use /end-review to try again.", "info");
				return;
			}

			const action: EndReviewAction =
				choice === "returnAndFix"
					? "returnAndFix"
					: choice === "returnAndSummarize"
						? "returnAndSummarize"
						: "returnOnly";

			await executeEndReviewAction(ctx, action, {
				notifySuccess: true,
			});
		} finally {
			endReviewInProgress.delete(sessionId);
			reviewUI(ctx).setReturning(false);
		}
	}

	// Register the /end-review command
	pi.registerCommand("end-review", {
		description: "Complete review and return to original position",
		handler: async (_args, ctx) => {
			await runEndReview(ctx);
		},
	});
}
