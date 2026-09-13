---
description: Show the Change Report for the most recent Lock
---

Show the user the Change Report for their most recent Vibe Check.

Steps:
1. List locks (`cdir lock ls`) and pick the most recent one, or the lock id
   the user gave: $ARGUMENTS
2. Call `report` for that lock.
3. Present the plain-language summary first. Then: any violations (named
   exactly), the checks with their evidence classes, and the Unchecked
   bucket — always visible, never summarized away.
4. If the verdict is not "verified", say so plainly and offer `cdir undo`.
