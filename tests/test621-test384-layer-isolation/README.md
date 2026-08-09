# test621 — test384 hold-open layer isolation

This narrow suite pins the adjudication for issue #458:

- an inbox task that is not acknowledged before process shutdown is eligible
  for at-least-once delivery after restart;
- test384 must therefore cancel its intentional L5 hold-open task before L6;
- cancellation must make the task terminal and acknowledge the inbox row;
- removing the layer-boundary cancellation is a witnessed-red mutation.

It uses an isolated real Hub and SQLite database. It does not contact or
modify production.
