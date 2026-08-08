# Skill writing guide

Use this workflow when a repeated agent task has become stable enough to reuse.

## Write the trigger

State when the skill should run and when it should not. Prefer observable
conditions over broad topic labels.

## Record the smallest reliable workflow

1. List required inputs and preconditions.
2. Put safety or authorization checks before mutations.
3. Describe the normal path in executable order.
4. Name failure states and safe recovery actions.
5. Keep environment-specific values in configuration, not in the skill.

## Make claims testable

For each important guarantee, add a check that fails when the guarantee is
removed. Record the exact command and expected result. Do not use a green
build as evidence for behavior the build does not exercise.

## Remove private context

Before public submission, remove tokens, internal hostnames, personal paths,
private URLs, customer data, and identities that are not part of the public
workflow. Choose an explicit license and publish changed content as a new
version.

