---
name: brai-adversarial-ux
description: Test a published Brai Preview as a difficult, impatient, non-technical user and separate genuine UX failures from persona noise. Use for adversarial UX review, cold-start testing, friction analysis, accessibility checks, launch readiness, or evaluation of a core user workflow.
---

# Brai adversarial UX

## Set the test

1. Define one concrete persona: goal, technical comfort, constraints, abandonment trigger, and actual task.
2. Test the persona's core job first, not a feature tour.
3. Use the real published HTTPS Preview. Authenticate through Caddy Basic Auth from the protected credential file, then complete Brai's own login.
4. Use the required isolated Chrome DevTools flow; do not substitute localhost, direct ports, Caddy bypass, or another browser.

## Exercise the workflow

Test on desktop and mobile viewports:

- first impression and cold start;
- core task completion and step count;
- terminology and navigation;
- empty, loading, validation, offline, and recovery states relevant to the task;
- readability, contrast, focus order, target sizes, and keyboard basics;
- console errors, page errors, and failed network requests after significant actions.

Capture the exact route, steps, expected behavior, actual behavior, and screenshot for each finding. Never expose credentials or private user data in evidence.

## Apply the pragmatism filter

Classify every complaint:

- `REAL`: blocks or confuses ordinary users; fix it.
- `ACCESSIBILITY`: violates an accessibility basic; fix it.
- `LOW PRIORITY`: valid mainly for an edge persona; retain as evidence.
- `FEATURE`: useful product opportunity, not a defect.
- `NOISE`: resistance or preference that does not justify product complexity.

Do not turn raw persona reactions into tasks. De-duplicate findings and keep the highest-impact evidence.

## Deliver

Report tested scope, persona verdict, findings ordered by severity, screenshots, console/network evidence, and untested areas. Create Inbox or GitHub tickets only when the project owner explicitly requests external tracking; otherwise provide the actionable report without side effects.
