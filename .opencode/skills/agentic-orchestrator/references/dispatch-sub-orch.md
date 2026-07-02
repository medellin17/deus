# Dispatch Template: Sub-Orchestrator Delegation

When the main conductor decides to delegate multi-domain work to sub-orchestrators, emit the `[SUBORCH]` signal.

## Signal Format

```
[SUBORCH]
[
  {
    "domain": "Auth",
    "subTask": "Implement OAuth2 login with Google and GitHub. Create endpoints, middleware, and tests.",
    "kbContext": "Project uses FastAPI with JWT. Existing auth in src/auth.py. Use authlib library. Follow patterns in src/auth/middleware.py."
  },
  {
    "domain": "Frontend",
    "subTask": "Create login page and registration form with client-side validation. Connect to Auth API.",
    "kbContext": "Next.js 14 with App Router. Tailwind CSS. Use server actions for form handling. Existing API client in lib/api.ts."
  }
]
```

## DomainTask Object

Each object in the array:

| Field | Required | Description |
|-------|----------|-------------|
| `domain` | Yes | Short domain name (e.g., "Auth", "Database", "Frontend") |
| `subTask` | Yes | Detailed task: what to build, tech stack, constraints, acceptance criteria. Be specific — the sub-orchestrator only sees this. |
| `kbContext` | Recommended | Project context: existing patterns, file paths, conventions, dependencies. Sub-orchestrators have no project knowledge. Be thorough. |
| `dependsOn` | No | Array of domain names this domain depends on. Use when domains must be sequential. |

## Guidelines for Writing subTask

- **Be concrete.** "Implement OAuth2" → "Create /auth/google and /auth/github endpoints returning JWT. Add middleware for token validation. Write tests for happy path and error cases."
- **Include acceptance criteria.** "Tests must pass. Endpoints must return 200 with valid token."
- **Specify constraints.** "Use existing JWT utilities from src/auth/jwt.ts. Don't create new auth framework."
- **Provide full kbContext.** The sub-orchestrator cannot explore the project — it only has what you give it. Include: relevant file paths, existing patterns, API signatures, dependencies.

## After the Signal

The system:
1. Parses the JSON array
2. Spawns sub-orchestrators in parallel (batches of `--max-depth`, default 3)
3. Waits for all reports
4. Aggregates into a synthesis
5. Injects `## Sub-Orchestrator Results` back into your session

You continue normally — integration, QA, final synthesis. The sub-orchestrator results are now part of your context.

## Example: What the Synthesis Looks Like

```
## Sub-Orchestrator Results

### Auth [done]
Summary: OAuth2 endpoints for Google and GitHub created. JWT middleware added. 12 tests pass.
Artifacts: src/auth/oauth.py, src/auth/oauth_middleware.py, tests/test_oauth.py
Decisions: Used authlib library. Session-based tokens with 1h expiry.
Recommendations: Add rate limiting on /auth/* endpoints.

### Frontend [done]
Summary: Login and registration pages with form validation. Connected to Auth API via server actions.
Artifacts: app/login/page.tsx, app/register/page.tsx, lib/auth-actions.ts
Decisions: Server actions for form handling. Client-side zod validation.
Recommendations: Add loading states and error toasts.

Continue with integration and final QA.
```
