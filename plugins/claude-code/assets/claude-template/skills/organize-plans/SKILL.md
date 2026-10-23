---
name: organize-plans
description: Review all plans, update statuses, check progress, and organize them
allowed-tools: Bash, Read
user-invocable: true
argument-hint: [focus]
---

# Organize Plans Skill

Review and organize every implementation plan in the project.

## Process

1. **Fetch all plans**: `quadflow plans list --json` (`data` is an array of full plans, steps included).

2. **For each plan**, analyze:
   - Step completion: completed / non-skipped steps
   - Whether `status` matches actual progress
   - Whether the linked idea (`ideaId`) still exists: `quadflow ideas get <ideaId> --json`
   - Staleness: `updatedAt` (epoch ms) far in the past

3. **Correct plan statuses**. The lifecycle is
   `spec_draft` → `spec_review` → `decomposing` → `review_steps` → `promoting` → `executing` → `completed`.
   - All non-skipped steps completed → `completed`
   - Any step in progress or completed, or steps promoted to issues → `executing`
   - Steps exist but none started or promoted → `review_steps`
   - Spec written, no steps yet → `spec_review` (or `decomposing` if decomposition has begun)
   - No spec and no steps → `spec_draft`

   The CLI moves plans to `executing` / `completed` automatically as steps change, so mismatches are usually old or hand-edited plans. Propose the changes, then apply:

   ```bash
   quadflow plans update <plan-id> --status executing
   ```

4. **Look for problems**:
   - Plans with no steps
   - Plans linked to deleted ideas (clear with `quadflow plans update <plan-id> --idea none`)
   - Plans not updated in a long time
   - Duplicate or overlapping plans (`quadflow plans list --search "<keywords>" --json`)
   - Promoted steps whose issue is gone (step `issueId` that `quadflow issues get` cannot find)

5. **Report**:
   - Plans per status
   - Plans that need attention, and why
   - Cleanup suggestions (merge, delete with `quadflow plans delete <plan-id>` only after the user confirms)
   - Progress overview

## Focus Areas

If $ARGUMENTS specifies a focus:
- `stale`: plans not updated recently
- `progress`: step statuses (see `/update-plan-progress`)
- `cleanup`: duplicates and empty plans
- `status`: correcting plan statuses
