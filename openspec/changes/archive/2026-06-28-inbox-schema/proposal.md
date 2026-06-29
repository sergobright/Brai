# Inbox Schema

## Summary

Add `inbox` as a Bright OS work entity for incoming items, with a first UI and
offline-first sync path.

## Capabilities

- `inbox`: SQLite storage for incoming item title, description, source, date,
  author, preliminary section, urgency, attachment links, explanation,
  normalization text, and normalization status.
- Inbox sync event log: clients can create, edit title/description, and delete
  incoming items before the canonical inbox row exists on the server.
- Inbox page: a list/detail interface similar to Actions, with Markdown
  description editing and type icons instead of status checkboxes.

## Rationale

Incoming material needs a durable place before it is normalized into a final
section or workflow item. The client needs to be able to capture that material
offline, so server writes are modeled as inbox events and projected into the
canonical `inbox` table without a foreign-key dependency on an existing inbox row.
