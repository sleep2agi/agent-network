// #472(MCP 任务生命周期测试报告问题 4)—— 任务 / 项目接口的错误不再只有一个代码。
//
// 以前回 `{ ok:false, error:"invalid_due" }`:app 按代码自己出文案,能用;但 MCP 上的 Agent 拿到的就只有这个词,
// 不知道哪个字段错了、正确的格式是什么、下一步该调哪个工具。这里给每个代码配上:
//   field   —— 出错的字段(有的话),
//   message —— 一句英文说明(MCP 工具描述都是英文,读的是 LLM;app 不显示它),
//   hint    —— 怎么改 / 下一步调什么。
// 🔴 `error` 字符串原样不变:app、测试、脚本都按它匹配。新增的三个键旧客户端不认识,直接忽略。
// 只有一个出口:requirements.ts 的 jsonError() 和抛错转换都走 errorBody(),不在调用点各写各的。

export type ErrorContext = {
  /** 出错的字段(调用点知道时传;不传就用登记表里的默认字段)。 */
  field?: string;
  /** 请求里实际带了哪些键(empty_patch 用来指出「你传了 status,该用 column」)。 */
  sent?: readonly string[];
  /** 可写字段(empty_patch 列出来)。 */
  writable?: readonly string[];
  /** 出错的那个值(project_not_in_network 用来判断是不是传了项目名)。 */
  value?: unknown;
};

type Detail = { field?: string; message: string; hint?: string };
type Entry = Detail | ((ctx: ErrorContext) => Detail);

const DUE_FORMATS = 'YYYY-MM-DD (all day) or ISO 8601 with Z / ±HH:MM (e.g. 2026-10-10T18:00:00+08:00); "" clears it';
// #473 —— 人员字段也收名字({kind:'user', username} / {kind:'node', alias}),只在任务所在的网络里解析;查人用 requirements_people。
const PERSON_IDS = "Look people up with requirements_people (q= filters by name): it returns each member's user_id and username and the node_id and alias of their Agents. Pass {kind:'user', id} or {kind:'user', username}, {kind:'node', id} or {kind:'node', alias}; names resolve only in the task's own network.";

const ENTRIES: Record<string, Entry> = {
  // ── 定位 / 范围 ──
  network_id_required: { field: 'network_id', message: 'This token can see more than one network (or is not bound to one), so the network must be named.', hint: 'Pass network_id (the network the task or project belongs to).' },
  ambiguous_seq: { field: 'id', message: 'That #N exists in more than one network you can see.', hint: 'Pass network_id, or use the req_… id.' },
  requirement_not_found: { field: 'id', message: 'No task with that id or #N in this network (or you cannot see it).', hint: 'Find it with requirements_list (q= searches titles; include_archived=true also lists archived tasks).' },
  not_found: { message: 'No such task, project or route.', hint: 'Check the id; requirements_list / projects_list return the ids you can use.' },
  project_not_found: { field: 'id', message: 'No project with that id in this network.', hint: 'Call projects_list to get project ids (proj_…).' },
  tag_not_found: { field: 'tag', message: 'No task in this network carries that tag.', hint: 'Tags are free text on tasks; list the ones in use from requirements_list (view=summary shows each task’s tags).' },
  checklist_item_not_found: { field: 'item_id', message: 'This task has no checklist item with that id.', hint: 'Item ids (ck_…) are in requirements_get → checklist[].id.' },
  // ── 权限 ──
  user_token_required: { message: 'This operation is for people only: a node token can read projects and read / create / update tasks, but cannot manage projects or delete tasks.', hint: 'Use an existing project (projects_list), or ask a person to create / change the project in the app (任务 → 管理项目).' },
  permission_denied: { message: 'Your role in this network cannot do this (read-only, or task-scoped to other projects).', hint: 'Ask a network admin for write access, or work on tasks you can see.' },
  upsert_not_allowed: { message: 'Task-scoped members cannot upsert by external_ref.', hint: 'Use requirements_create / requirements_update on tasks you can see.' },
  external_ref_not_allowed: { field: 'external_ref', message: 'Task-scoped members cannot set external_ref.', hint: 'Leave external_ref out.' },
  // ── 人员 ──
  invalid_person: (ctx) => ({ field: ctx.field ?? 'owner', message: 'A person must be an object {kind:"user", id | username} or {kind:"node", id | alias}.', hint: PERSON_IDS }),
  person_not_in_network: (ctx) => ({ field: ctx.field ?? 'owner', message: `${ctx.field ?? 'owner'} names nobody in this network (unknown id / username / alias, wrong kind, or a node you cannot see).`, hint: PERSON_IDS }),
  person_ambiguous: (ctx) => ({ field: ctx.field ?? 'agent_owner', message: 'More than one Agent in this network has that alias.', hint: 'Call requirements_people (q=<alias>) and pass the node_id instead.' }),
  owner_must_be_human: { field: 'owner', message: 'owner (负责人) must be a person.', hint: "Use owner: {kind:'user', id}. To assign a node / Agent, use agent_owner: {kind:'node', id}." },
  agent_owner_must_be_agent: { field: 'agent_owner', message: 'agent_owner (负责 Agent) must be a node.', hint: "Use agent_owner: {kind:'node', id}. To assign a person, use owner: {kind:'user', id}." },
  agent_owner_not_granted: { field: 'agent_owner', message: 'The current responsible Agent is one you are not granted, so you cannot replace or clear it.', hint: 'Leave agent_owner out of the patch.' },
  invalid_participants: { field: 'participants', message: 'participants must be an array of up to 100 persons {kind, id}; it replaces the whole list.', hint: 'Send the full list you want (read it first with requirements_get).' },
  department_scope_denied: { field: 'owner', message: 'As a department head you can hand this task only to people in your department (or yourself) and to their Agents.', hint: 'Pick someone from your department, or ask an owner / admin to move it to another department.' },
  department_not_found: { field: 'department_id', message: 'No department with that id in your network(s).', hint: 'Department ids come from GET /api/networks/{id}/departments.' },
  invalid_participants_delta: { field: 'participants_add', message: 'participants_add / participants_remove must each be an array of up to 100 persons ({kind, id}, {kind:"user", username} or {kind:"node", alias}).', hint: PERSON_IDS },
  participants_conflict: { field: 'participants', message: 'participants (replace the whole list) cannot be combined with participants_add / participants_remove.', hint: 'Use participants_add / participants_remove to change a few people, or participants alone to replace the list.' },
  participants_add_remove_overlap: { field: 'participants_remove', message: 'The same person is in both participants_add and participants_remove.', hint: 'Send each person in only one of the two lists.' },
  too_many_participants: { field: 'participants_add', message: 'A task can have at most 100 participants.', hint: 'Remove some with participants_remove first.' },
  status_conflicts_with_column: { field: 'status', message: 'status is an alias of column, and the two values sent differ.', hint: 'Send only one of them (pool, doing, done or abandoned).' },
  invalid_assignee: { field: 'assignee', message: 'assignee must be a string (legacy free-text field).', hint: 'Prefer owner / agent_owner.' },
  // ── 项目 ──
  invalid_project: { field: 'project_id', message: 'project_id must be a project id string or null.', hint: 'Call projects_list to get project ids (proj_…); null removes the task from its project.' },
  project_not_in_network: (ctx) => {
    const looksLikeName = typeof ctx.value === 'string' && !/^proj_/.test(ctx.value);
    return {
      field: ctx.field ?? 'project_id',
      message: looksLikeName ? `"${String(ctx.value).slice(0, 40)}" is not a project id — it looks like a project name.` : 'No project with that id in this network.',
      hint: 'Call projects_list and pass the project’s id (proj_…), not its name.',
    };
  },
  project_archived: { field: 'project_id', message: 'That project is archived.', hint: 'Pick an active project from projects_list, or ask a person to unarchive it.' },
  project_name_taken: { field: 'name', message: 'A project with that name already exists in this network.', hint: 'Use the existing one (projects_list) or choose another name.' },
  invalid_project_name: { field: 'name', message: 'Project name must be 1–40 characters.' },
  invalid_project_color: { field: 'color', message: 'color must be #RRGGBB.' },
  invalid_project_sort: { field: 'sort', message: 'sort must be an integer.' },
  invalid_project_archived: { field: 'archived', message: 'archived must be true or false.' },
  too_many_projects: { message: 'This network has reached the project limit (200).', hint: 'Reuse an existing project (projects_list).' },
  // ── 任务字段 ──
  empty_patch: (ctx) => {
    const sent = ctx.sent ?? [];
    const writable = ctx.writable?.length ? ctx.writable.join(', ') : 'name, column, priority, due, start, description, checklist, tags, owner, agent_owner, participants, project_id, parent_id, external_ref, external_url, archived';
    const statusHint = sent.includes('status') ? 'To move a task between pool / doing / done / abandoned, use column (status is the name of the list filter). ' : '';
    return { message: sent.length ? `None of the keys sent (${sent.join(', ')}) is a writable field.` : 'The patch changes nothing.', hint: `${statusHint}Writable fields: ${writable}.` };
  },
  invalid_json: { message: 'The request body must be a JSON object.' },
  invalid_name: { field: 'name', message: 'name must be 1–80 characters.' },
  invalid_description: { field: 'description', message: 'description must be a string (markdown) of at most 20 000 characters.' },
  invalid_column: { field: 'column', message: 'column must be pool, doing, done or abandoned.' },
  invalid_status: { field: 'status', message: 'status (list filter) must be pool, doing, done or abandoned.' },
  invalid_priority: { field: 'priority', message: 'priority must be high (P0), normal (P1), low (P2) or lowest (P3).' },
  invalid_due: { field: 'due', message: 'due is not a date this hub understands.', hint: `Use ${DUE_FORMATS}.` },
  invalid_start: { field: 'start', message: 'start is not a date this hub understands.', hint: `Use ${DUE_FORMATS}.` },
  invalid_tags: { field: 'tags', message: 'tags must be an array of at most 10 strings, each 1–20 characters.', hint: 'Omit tags to keep them, [] to clear.' },
  invalid_checklist: { field: 'checklist', message: 'checklist must be an array of up to 100 items {text (1–500 chars), done?, id?}; it replaces the whole list.', hint: 'To tick one item use requirements_checklist_toggle (item ids from requirements_get).' },
  invalid_done: { field: 'done', message: 'done must be true or false.' },
  invalid_parent_id: { field: 'parent_id', message: 'parent_id must be a task id in this network (or null to detach).', hint: 'Get the parent’s req_… id from requirements_list / requirements_get.' },
  parent_cycle: { field: 'parent_id', message: 'That parent would make the task its own ancestor.', hint: 'Pick a parent that is not this task or one of its children.' },
  parent_too_deep: { field: 'parent_id', message: 'Tasks nest at most 5 levels.', hint: 'Attach it to a higher-level task.' },
  parent_not_found: { field: 'parent_id', message: 'No task with that parent_id in this network (or you cannot see it).', hint: 'Get the parent’s req_… id from requirements_list / requirements_get.' },
  invalid_external_ref: { field: 'external_ref', message: 'external_ref must start with a letter or digit and use only letters, digits and _ . : / # @ + - (≤ 200 characters).', hint: 'e.g. github:owner/repo#123' },
  external_ref_required: { field: 'external_ref', message: 'external_ref is required for upsert.' },
  external_ref_exists: { field: 'external_ref', message: 'A task with that external_ref already exists in this network (existing_id).', hint: 'Use requirements_upsert_by_external_ref to sync, or requirements_update on existing_id.' },
  invalid_external_url: { field: 'external_url', message: 'external_url must be an http(s) URL of at most 500 characters, or null.' },
  invalid_issues: { field: 'issues', message: 'issues must be an array of issue references.' },
  invalid_archived: { field: 'archived', message: 'archived must be true or false.' },
  invalid_seq: { field: 'seq', message: 'seq must be a positive integer (the #N shown for a task).' },
  invalid_client_id: { field: 'client_id', message: 'client_id must be 1–80 characters of letters, digits, ., _ or -.' },
  client_id_taken: { field: 'client_id', message: 'That client_id was already used for another task.', hint: 'Generate a new client_id for each new task.' },
  // ── 列表 / 事件 ──
  invalid_view: { field: 'view', message: 'view must be full or summary.' },
  invalid_last_event: { field: 'last_event', message: 'last_event must be 1 or 0 (REST). On MCP use include_last_event: true / false.' },
  invalid_overdue: { field: 'overdue', message: 'overdue must be true or false (REST: 1 / 0 / true / false).' },
  invalid_due_within_days: { field: 'due_within_days', message: 'due_within_days must be an integer from 0 to 365 (0 = due later today).' },
  invalid_limit: { field: 'limit', message: 'limit is out of range.' },
  invalid_cursor: { field: 'cursor', message: 'cursor is not one this hub issued.', hint: 'Pass next_cursor from the previous page unchanged, or start again without cursor.' },
  invalid_updated_since: { field: 'updated_since', message: 'updated_since must be an ISO 8601 time.', hint: 'Use server_time from the previous changes=true response.' },
  updated_since_required: { field: 'updated_since', message: 'changes=true needs updated_since.', hint: 'Pass updated_since (ISO time; server_time from the last call).' },
  invalid_since: { field: 'since', message: 'since must be an ISO 8601 time.', hint: 'Use server_time from the previous requirements_events response.' },
  invalid_comment: { field: 'text', message: 'A comment needs non-empty text.', hint: 'Pass text (markdown), e.g. a progress note or a conclusion.' },
  comment_too_long: { field: 'text', message: 'A comment can be at most 4000 characters.', hint: 'Split it into several comments, or put the long part in the description.' },
  insert_failed: { message: 'The hub could not save the task.', hint: 'Retry once; if it fails again, report it.' },
};

/** 错误响应体:`error` 原样,补上 field / message / hint(登记表里没有的代码就只有 error,和以前一样)。 */
export function errorBody(error: string, ctx: ErrorContext = {}): { ok: false; error: string; field?: string; message?: string; hint?: string } {
  const entry = ENTRIES[error];
  if (!entry) return { ok: false, error };
  const d = typeof entry === 'function' ? entry(ctx) : entry;
  const field = ctx.field ?? d.field;
  return { ok: false, error, ...(field ? { field } : {}), message: d.message, ...(d.hint ? { hint: d.hint } : {}) };
}

/** 带字段的抛错:assignments / projectRef 里抛,调用点的 catch 用 errorFrom() 转成响应。 */
export class RequirementFieldError extends Error {
  constructor(code: string, readonly field?: string, readonly value?: unknown) { super(code); }
}

export function errorFrom(e: unknown, status = 400): Response {
  const code = (e as Error)?.message ?? 'invalid_json';
  const fe = e instanceof RequirementFieldError ? e : null;
  return Response.json(errorBody(code, { field: fe?.field, value: fe?.value }), { status });
}

/** Test-only: every code with an entry. */
export const __documentedErrorCodes = (): string[] => Object.keys(ENTRIES);
