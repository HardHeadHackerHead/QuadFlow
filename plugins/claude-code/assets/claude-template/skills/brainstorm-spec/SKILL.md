---
name: brainstorm-spec
description: Interactive brainstorm session to explore an idea and generate a spec document. Creates the spec collaboratively with the user.
argument-hint: <plan_id> [initial idea description]
allowed-tools: Bash, Read, Glob, Grep
---

# Brainstorm Spec

An interactive session that helps the user develop their idea into a full specification document for a plan.

## Process

1. Get the plan (first argument): `quadflow plans get <plan_id> --json`. If there is no plan yet, offer to create one: `quadflow plans create "<title>" --spec-kind feature --json` (the id is `data.id`).
2. Note the spec kind, `data.spec.kind` (`greenfield` / `feature` / `refactor`; `feature` if no spec yet). Ask the user if it is unclear.
3. Use the remaining arguments as the starting idea, along with the plan's description and, if `ideaId` is set, the idea (`quadflow ideas get <ideaId> --json`).
4. For a feature or refactor, explore the codebase first to understand the existing architecture.

## Brainstorm Flow

Acknowledge the idea, then ask targeted questions to flesh it out, working through:

### 1. Vision & Goals
- What problem does this solve?
- Who is the target user?
- What does success look like?

### 2. Core Requirements
- Must-haves vs nice-to-haves
- Constraints (tech stack, timeline, budget)

### 3. Technical Approach
- What architecture makes sense?
- Which technologies/frameworks?
- How does it integrate with the existing system? (feature/refactor)

### 4. Edge Cases & Risks
- What could go wrong?
- What are the hardest parts?
- Security or performance concerns?

### 5. Scope Definition
- In scope vs out of scope
- MVP vs full vision

## When the User is Ready

When the conversation reaches a natural conclusion (or the user says they're ready):

1. Compile everything into a structured markdown spec:
   - Overview
   - Goals & Success Criteria
   - Requirements (Functional & Non-functional)
   - Architecture & Design
   - Data Model
   - API Design
   - Security
   - Testing Strategy
   - Open Questions (if any remain)

2. Save it and move the plan to `spec_review`:

   ```bash
   quadflow plans update <plan_id> --spec-kind feature --status spec_review --spec-content "$(cat <<'EOF'
   # <Title>

   ## Overview
   ...
   EOF
   )"
   ```

3. Tell the user the spec is saved, that they can review it in the Plans tool, and that `/review-spec <plan_id>` is the next step.

## Guidelines

- Be conversational and collaborative; this is a brainstorm, not an interrogation
- Ask 2-3 questions at a time
- Build on the user's answers and suggest things they may not have considered
- For feature/refactor plans, reference actual code and patterns
- Don't generate the spec until the user is ready
- The spec reflects THEIR vision; you are helping them articulate it
