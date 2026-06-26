# Inbox Schema

## Summary

Add `inbox` as a server-side Bright OS work entity for incoming items.

## Capabilities

- `inbox`: SQLite storage for incoming item title, description, source, date,
  author, preliminary section, urgency, attachment links, explanation,
  normalization text, and normalization status.

## Rationale

Incoming material needs a durable place before it is normalized into a final
section or workflow item. A plain server table is enough for the first step; UI
and sync behavior can follow when the product flow is defined.
