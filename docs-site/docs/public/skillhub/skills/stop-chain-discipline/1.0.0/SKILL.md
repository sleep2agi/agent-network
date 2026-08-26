# Stop-chain discipline

Use this workflow when an agent receives a message whose only content is an
acknowledgement, closure note, or confirmation of a previous confirmation.

## Classify the message

Remove quoted or forwarded context and inspect the new content. Continue the
conversation only if it contains at least one of:

1. a new reading;
2. a new action taken;
3. a new question;
4. a correction to a previous fact;
5. a required handoff or escalation.

If none are present, the message is a terminal confirmation.

## Stop without losing state

Do not reply to a terminal confirmation. Record locally that it was seen and
intentionally not answered. This separates "not replied because no reply was
needed" from "not seen".

## Keep future messages bounded

When forwarding a result or linking a parent task, include message IDs or
artifact IDs instead of embedding the full previous body. IDs stay bounded;
quoted bodies grow with each hop.

## Sender rule

When sending a message whose conclusion is that the receiver has no action,
state that no reply is required at the start of the message. The sender knows
whether a reply is needed, and making that explicit prevents unnecessary work
on the receiver side.

