# qa-hub-16-rest-task-api

Status: PASS

Verified:

- POST /api/task accepts parent_task_id.
- POST /api/task returns task_id and message_id.
- GET /api/tasks/:id returns a single task JSON object.
- GET /api/task/:id alias also returns the single task.
- Unknown task id returns 404 JSON.

Sample task_id: `40d06684-eac7-4287-86cf-5db83982584d`
