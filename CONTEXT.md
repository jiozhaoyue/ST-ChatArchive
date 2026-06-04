# JSON Chat Archive Context

This context describes the domain language for a Luker/SillyTavern-compatible chat archiving feature that compacts multiple original chats while preserving the ability to restore them.

## Language

**Chat Archive Pack**:
A portable JSON archive container that can be attached to or detached from a character card and can represent multiple original chats.
_Avoid_: JSON chat group, group chat, chat compression package

**Original Chat**:
A chat that exists in Luker/SillyTavern as a normal `.jsonl` chat file.
_Avoid_: raw file, old chat, source file

**Materialized Chat**:
An original-chat-compatible `.jsonl` file restored from a chat archive pack.
_Avoid_: released file, generated file

## Relationships

- A **Chat Archive Pack** can represent one or more **Original Chats**.
- A **Chat Archive Pack** can be attached to zero or more character cards over time.
- A **Materialized Chat** belongs to exactly one active Luker/SillyTavern character chat directory at the moment it is restored.

## Example dialogue

> **Dev:** "When the user opens a **Chat Archive Pack**, should it appear in the normal group chat list?"
> **Domain expert:** "No. It is not a group chat; it only becomes visible to the native chat system after one of its chats is restored as a **Materialized Chat**."

## Flagged ambiguities

- "JSON chat group" was used to mean an archive container, not a Luker/SillyTavern group chat. Resolved: use **Chat Archive Pack**.
