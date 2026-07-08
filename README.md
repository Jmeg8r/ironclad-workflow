# Ironclad Workflow

A structured 4-phase workflow framework that enforces quality through planning gates, AI code review, verification checkpoints, and file integrity tracking.

## Philosophy

Inspired by [Claudikins Kernel](https://github.com/elb-pr/claudikins-kernel), this workflow ensures:

- **Nothing ships without a plan** - Forced design before coding
- **Nothing ships unreviewed** - AI-powered code review using Google Gemini
- **Nothing ships unverified** - Automated tests, visual verification, security review
- **Nothing ships modified** - File integrity tracking between verify and ship
- **Humans stay in control** - Mandatory checkpoints at each phase

## The 4 Phases

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  PLAN    │───►│ EXECUTE  │───►│  VERIFY  │───►│   SHIP   │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
     │               │               │               │
     ▼               ▼               ▼               ▼
  plan.md        code +          AI review +     PR + merge
  approved       session.md      verify-state
```

### Phase 1: PLAN

Before writing any code:
1. Create a plan document using the template
2. Define problem statement and success criteria
3. Complete security considerations
4. Break down tasks with dependencies
5. **Get human approval**

### Phase 2: EXECUTE

Implement the planned tasks:
1. Create feature branch
2. Work through tasks in order
3. Update session documentation
4. Mark tasks complete in plan
5. Run linting/formatting

### Phase 3: VERIFY

Validate the implementation:
1. Run `node scripts/verify.js`
   - Automated tests
   - Linting
   - Security audit (npm audit)
   - **AI Code Review (Gemini)**
2. Complete verification checklist
3. Address AI review findings
4. Perform visual verification
5. **Get human approval**

### Phase 4: SHIP

Merge the verified code:
1. Run `node scripts/ship.js`
2. File hashes must match verification
3. Create PR with evidence
4. Include AI review summary
5. **Get human approval for merge**

## AI Code Review (Gemini)

The workflow includes automated code review powered by Google Gemini, providing:

### Security Review
- Input validation and sanitization
- SQL injection, XSS vulnerabilities
- Authentication/authorization issues
- Sensitive data exposure
- Path traversal attacks
- Hardcoded secrets

### Quality Review
- Code clarity and readability
- Error handling completeness
- Edge case coverage
- Performance concerns
- Best practices violations

### Setup

```bash
# Set your Gemini API key
export GEMINI_API_KEY="your-api-key"
```

### Usage

```bash
# Full verification (includes AI review)
node scripts/verify.js

# Skip AI review
node scripts/verify.js --skip-ai-review

# Standalone AI review
node scripts/ai-review.js

# Review only git changes
node scripts/ai-review.js --diff

# Security-focused review only
node scripts/ai-review.js --security-focus
```

### Review Output

AI review results are saved to `.workflow/state/ai-review.json`:

```json
{
  "timestamp": "2026-01-19T15:00:00.000Z",
  "summary": {
    "securityRisk": "LOW",
    "codeQuality": "GOOD",
    "passesReview": true
  },
  "securityReview": {
    "issues": [],
    "positives": ["Input validation present", "Parameterized queries used"]
  },
  "qualityReview": {
    "issues": [],
    "strengths": ["Clear function names", "Good error handling"]
  }
}
```

## Quick Start

### 1. Copy to Your Project

```bash
# Copy the workflow files to your project
cp -r ironclad-workflow/.workflow your-project/
cp -r ironclad-workflow/scripts your-project/
```

### 2. Set Up API Key

```bash
# Add to your shell profile (.bashrc, .zshrc, etc.)
export GEMINI_API_KEY="your-api-key"
```

### 3. Start a New Feature

```bash
# Create a session directory
mkdir -p .workflow/sessions/SESSION-$(date +%Y-%m-%d)-feature-name

# Copy the plan template
cp .workflow/templates/plan-template.md .workflow/sessions/SESSION-$(date +%Y-%m-%d)-feature-name/plan.md

# Edit the plan, then get approval before coding
```

### 4. After Implementation

```bash
# Generate verification state (includes AI review)
node scripts/verify.js

# Review AI findings
cat .workflow/state/ai-review.json

# Address any issues, then ship
node scripts/ship.js --create-pr
```

## Directory Structure

```
your-project/
├── .workflow/
│   ├── templates/               # Document templates (don't modify)
│   │   ├── plan-template.md
│   │   ├── session-template.md
│   │   └── pr-template.md
│   ├── checklists/              # Review checklists
│   │   ├── verify-checklist.md       # Per-change verification gates
│   │   ├── security-review.md        # Per-change security review
│   │   └── pre-release-checklist.md  # Full-app pre-release review
│   ├── sessions/                # Active session documents
│   │   └── SESSION-YYYY-MM-DD-slug/
│   │       ├── plan.md
│   │       └── session.md
│   └── state/                   # Verification state files
│       ├── verify-state.json    # Main verification state
│       └── ai-review.json       # AI review results
└── scripts/
    ├── verify.js                # Full verification with AI
    ├── ai-review.js             # Standalone AI review (Gemini)
    └── ship.js                  # Validate integrity + create PR
```

## Scripts

### verify.js

Full verification including:
- SHA256 hashes of source files
- Test results
- Lint status
- Security audit
- **AI code review (Gemini)**

```bash
node scripts/verify.js [options]

Options:
  --skip-tests       Skip running tests
  --skip-lint        Skip running linter
  --skip-ai-review   Skip AI code review
  --security-focus   Focus AI on security only
```

### ai-review.js

Standalone AI code review:

```bash
node scripts/ai-review.js [options]

Options:
  --files <paths>    Comma-separated file paths
  --diff             Review git diff only
  --security-focus   Security review only
  --output <path>    Custom output path
```

### ship.js

Validates file integrity and prepares for shipping:

```bash
node scripts/ship.js [options]

Options:
  --create-pr     Create a GitHub PR (requires gh CLI)
  --dry-run       Show what would be done
```

## Security Features

The workflow enforces security through:

1. **Planning Phase** - Security considerations required in plan
2. **AI Review** - Automated security vulnerability detection
3. **Verification Phase** - Security checklist + npm audit
4. **Shipping Phase** - File integrity prevents unverified changes
5. **Pre-Release Gate** - Comprehensive checklist before releasing to users

### Per-Change vs. Pre-Release Security

| Checklist | When | Scope |
|-----------|------|-------|
| `security-review.md` | Every PR / code change | Code-level: injection, auth, data handling |
| `pre-release-checklist.md` | Before first release or major versions | Full-app: supply chain, infrastructure, CI/CD, docs |

Think of it this way: `security-review.md` inspects each weld on the bridge.
`pre-release-checklist.md` load-tests the whole bridge before opening it to traffic.

## Human Checkpoints

The workflow has **mandatory** human checkpoints:

| Checkpoint | When | Purpose |
|------------|------|---------|
| Plan Approval | After planning, before coding | Ensure design is sound |
| Verify Approval | After testing + AI review | Confirm quality, address findings |
| Ship Approval | Final merge decision | Human stays in control |

## Risk Levels

AI review categorizes findings by severity:

| Severity | Action Required |
|----------|-----------------|
| CRITICAL | Must fix before shipping |
| HIGH | Must fix before shipping |
| MEDIUM | Should fix or document acceptance |
| LOW | Recommended to fix |

## Adapting for Your Project

### Customize File Patterns

Edit `scripts/ai-review.js` to change which files are reviewed:

```javascript
const extensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go', '.rs'];
```

Both scripts scan `src/` when it exists and otherwise fall back to the project
root, so a project laid out without a `src/` directory is still reviewed.

### Add Project-Specific Review Criteria

Modify the review prompts in `ai-review.js` to include project-specific concerns.

### Integrate with CI

```yaml
- name: Verify
  env:
    GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
  run: node scripts/verify.js

- name: Check Ship Ready
  run: node scripts/ship.js --dry-run
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | For AI review | Google Gemini API key (sent via the `x-goog-api-key` header) |
| `VERIFY_CMD_TIMEOUT_MS` | No | Per-command timeout for test/lint/audit (default `300000`) |

## License

MIT
