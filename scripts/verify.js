#!/usr/bin/env node

/**
 * Verification Script
 * ===================
 * Generates verification state including:
 * - SHA256 hashes of source files
 * - Test results
 * - Lint status
 * - AI code review (Gemini)
 * - Timestamp
 * 
 * Usage: node scripts/verify.js [options]
 * 
 * Options:
 *   --skip-tests       Skip running tests
 *   --skip-lint        Skip running linter
 *   --skip-ai-review   Skip AI code review
 *   --security-focus   Focus AI review on security only
 * 
 * Environment:
 *   GEMINI_API_KEY     Required for AI review (optional if --skip-ai-review)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync, spawn } = require('child_process');

// Configuration
// WHAT: Extensions hashed for integrity tracking.
// WHY: Broader than the AI-review set (ai-review.js) on purpose — hashing
//      guards ALL source + asset files that shipping depends on (incl. .css
//      and .json), whereas AI review only sends actual code to the model.
const DEFAULT_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.css', '.json'];
const OUTPUT_PATH = '.workflow/state/verify-state.json';

// WHAT: Per-command wall-clock limit and output cap for spawned tools.
// WHY: Tests/lint/audit had no timeout and could hang the whole verification
//      indefinitely. Overridable via VERIFY_CMD_TIMEOUT_MS for slow suites.
const CMD_TIMEOUT_MS = parseInt(process.env.VERIFY_CMD_TIMEOUT_MS, 10) || 300000; // 5 minutes
const CMD_MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  skipTests: args.includes('--skip-tests'),
  skipLint: args.includes('--skip-lint'),
  skipAiReview: args.includes('--skip-ai-review'),
  securityFocus: args.includes('--security-focus'),
  outputPath: OUTPUT_PATH
};

// Utility functions
function hashFile(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch (error) {
    console.error('Error hashing ' + filePath + ':', error.message);
    return null;
  }
}

function findFiles(baseDir) {
  const files = [];
  
  function walkDir(dir) {
    if (!fs.existsSync(dir)) return;
    
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (DEFAULT_EXTENSIONS.includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  }
  
  const srcDir = path.join(baseDir, 'src');
  if (fs.existsSync(srcDir)) {
    walkDir(srcDir);
  } else {
    console.log('No src/ directory found. Scanning current directory...');
    walkDir(baseDir);
  }
  
  return files.sort();
}

function runCommand(command, description) {
  console.log('\n' + description + '...');
  try {
    const output = execSync(command, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CMD_TIMEOUT_MS,
      maxBuffer: CMD_MAX_BUFFER
    });
    return { success: true, output: output.trim() };
  } catch (error) {
    // A timeout kill surfaces as code 'ETIMEDOUT' (or a SIGTERM signal);
    // make that explicit rather than reporting an empty error.
    const timedOut = error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM';
    const message = timedOut
      ? 'Command timed out after ' + CMD_TIMEOUT_MS + 'ms: ' + command
      : (error.stderr ? error.stderr.trim() : error.message);
    return {
      success: false,
      output: error.stdout ? error.stdout.trim() : '',
      error: message
    };
  }
}

function runTests() {
  if (options.skipTests) {
    console.log('Skipping tests (--skip-tests)');
    return { skipped: true };
  }
  
  try {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    if (!pkg.scripts || !pkg.scripts.test) {
      console.log('No test script found in package.json');
      return { skipped: true, reason: 'no test script' };
    }
  } catch (e) {
    console.log('No package.json found');
    return { skipped: true, reason: 'no package.json' };
  }
  
  const result = runCommand('npm test 2>&1', 'Running tests');
  return {
    success: result.success,
    output: result.output,
    error: result.error
  };
}

function runLint() {
  if (options.skipLint) {
    console.log('Skipping lint (--skip-lint)');
    return { skipped: true };
  }
  
  try {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    if (!pkg.scripts || !pkg.scripts.lint) {
      console.log('No lint script found in package.json');
      return { skipped: true, reason: 'no lint script' };
    }
  } catch (e) {
    return { skipped: true, reason: 'no package.json' };
  }
  
  const result = runCommand('npm run lint 2>&1', 'Running linter');
  return {
    success: result.success,
    output: result.output,
    error: result.error
  };
}

function runAudit() {
  // Use --json for a machine-readable report. Note: no `2>&1` here — merging
  // stderr would corrupt the JSON. npm audit exits non-zero when vulns exist,
  // so runCommand() captures the report on error.output either way.
  const result = runCommand('npm audit --json', 'Running security audit');
  const raw = result.output || '';

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    parsed = null;
  }

  // No machine-readable report (e.g. no lockfile / ENOLOCK). Report as
  // inconclusive and surface it in the summary — never a silent pass on a
  // substring match, never a hard fail that breaks a legitimately dep-free repo.
  if (!parsed || parsed.error || !parsed.metadata || !parsed.metadata.vulnerabilities) {
    const reason = parsed && parsed.error
      ? (parsed.error.code || parsed.error.summary || 'audit error')
      : 'could not parse npm audit output';
    return { success: true, inconclusive: true, reason: reason, vulnerabilities: null };
  }

  const counts = parsed.metadata.vulnerabilities;
  const high = counts.high || 0;
  const critical = counts.critical || 0;

  return {
    success: high === 0 && critical === 0,
    vulnerabilities: counts
  };
}

const AI_RESULT_PATH = '.workflow/state/ai-review.json';

// WHAT: Read and normalize ai-review.js output into a summary object.
// WHY: Returns null when the file is absent or malformed so the caller can
//      distinguish "no fresh review" from a real verdict (see runAiReview).
function readAiResults(resultPath) {
  if (!fs.existsSync(resultPath)) {
    return null;
  }
  try {
    const aiResults = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
    if (!aiResults || !aiResults.summary) {
      return null;
    }
    return {
      success: aiResults.summary.passesReview,
      securityRisk: aiResults.summary.securityRisk,
      codeQuality: aiResults.summary.codeQuality,
      securityIssues: aiResults.securityReview?.issues?.length || 0,
      qualityIssues: aiResults.qualityReview?.issues?.length || 0,
      needsAttention: !aiResults.summary.passesReview
    };
  } catch (e) {
    return null;
  }
}

// WHAT: Minimal environment for the ai-review child process.
// WHY: Don't hand the child every secret in the parent environment. It only
//      needs PATH (to find git), HOME, and the Gemini key. SystemRoot/TEMP/TMP
//      are included so Node itself still works on Windows.
function buildAiChildEnv() {
  const keys = ['PATH', 'HOME', 'GEMINI_API_KEY', 'SystemRoot', 'TEMP', 'TMP'];
  const env = {};
  for (const key of keys) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function runAiReview() {
  if (options.skipAiReview) {
    console.log('Skipping AI review (--skip-ai-review)');
    return { skipped: true };
  }

  // Check for API key
  if (!process.env.GEMINI_API_KEY) {
    console.log('No GEMINI_API_KEY set, skipping AI review');
    console.log('Set with: export GEMINI_API_KEY="your-key"');
    return { skipped: true, reason: 'no API key' };
  }

  // Check if ai-review.js exists
  const aiReviewPath = path.join(__dirname, 'ai-review.js');
  if (!fs.existsSync(aiReviewPath)) {
    console.log('AI review script not found');
    return { skipped: true, reason: 'script not found' };
  }

  // WHAT: Delete any prior review result before running.
  // WHY: ai-review.js can exit 0 without writing a file (e.g. "no code found
  //      to review"). Without this, verify.js would read a STALE result from a
  //      previous run and misattribute it to the current code.
  try {
    if (fs.existsSync(AI_RESULT_PATH)) {
      fs.unlinkSync(AI_RESULT_PATH);
    }
  } catch (e) {
    console.warn('Warning: could not clear previous AI review result: ' + e.message);
  }

  console.log('\nRunning AI Code Review (Gemini)...');

  let spawnError = null;
  try {
    const aiArgs = options.securityFocus ? ['--security-focus'] : [];
    // Use execFileSync to avoid shell interpretation of the path
    execFileSync(process.execPath, [aiReviewPath, ...aiArgs], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildAiChildEnv(),
      timeout: 120000 // 2 minute timeout
    });
  } catch (error) {
    // ai-review.js exits non-zero when it finds issues that need attention;
    // that is expected, not a spawn failure. Distinguish below by whether a
    // fresh result file was written.
    spawnError = error;
    console.log('AI review completed with findings');
  }

  const results = readAiResults(AI_RESULT_PATH);
  if (results) {
    return results;
  }

  // No fresh result file was written. Do NOT fall back to stale data.
  if (spawnError) {
    return { success: false, error: spawnError.message, reason: 'ai-review produced no output' };
  }
  return { skipped: true, reason: 'no review output' };
}

// Main verification process
async function main() {
  console.log('='.repeat(60));
  console.log('VERIFICATION SCRIPT');
  console.log('='.repeat(60));
  console.log('Timestamp: ' + new Date().toISOString());
  
  // Find and hash files
  console.log('\nFinding source files...');
  const files = findFiles('.');
  console.log('Found ' + files.length + ' files to hash');
  
  const fileHashes = {};
  for (const file of files) {
    const hash = hashFile(file);
    if (hash) {
      fileHashes[file] = hash;
    }
  }
  
  // Run checks
  const testResults = runTests();
  const lintResults = runLint();
  const auditResults = runAudit();
  const aiReviewResults = runAiReview();
  
  // Build verification state
  const verifyState = {
    version: '1.1.0',
    timestamp: new Date().toISOString(),
    files: {
      count: Object.keys(fileHashes).length,
      hashes: fileHashes
    },
    tests: testResults,
    lint: lintResults,
    audit: auditResults,
    aiReview: aiReviewResults,
    summary: {
      filesHashed: Object.keys(fileHashes).length,
      testsPass: testResults.success || testResults.skipped,
      lintPass: lintResults.success || lintResults.skipped,
      auditPass: auditResults.success,
      aiReviewPass: aiReviewResults.success || aiReviewResults.skipped,
      overallPass: (testResults.success || testResults.skipped) &&
                   (lintResults.success || lintResults.skipped) &&
                   auditResults.success &&
                   (aiReviewResults.success || aiReviewResults.skipped)
    }
  };
  
  // Ensure output directory exists
  const outputDir = path.dirname(options.outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Write verification state
  fs.writeFileSync(
    options.outputPath,
    JSON.stringify(verifyState, null, 2)
  );
  
  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('VERIFICATION SUMMARY');
  console.log('='.repeat(60));
  console.log('Files hashed:    ' + verifyState.summary.filesHashed);
  console.log('Tests:           ' + (verifyState.summary.testsPass ? 'PASS' : 'FAIL'));
  console.log('Lint:            ' + (verifyState.summary.lintPass ? 'PASS' : 'FAIL'));

  const auditLabel = auditResults.inconclusive
    ? 'INCONCLUSIVE (' + auditResults.reason + ')'
    : (verifyState.summary.auditPass ? 'PASS' : 'FAIL');
  console.log('Security Audit:  ' + auditLabel);
  if (auditResults.vulnerabilities) {
    const v = auditResults.vulnerabilities;
    console.log('  Vulnerabilities: ' + (v.critical || 0) + ' critical, ' +
                (v.high || 0) + ' high, ' + (v.moderate || 0) + ' moderate, ' +
                (v.low || 0) + ' low');
  }

  console.log('AI Review:       ' + (verifyState.summary.aiReviewPass ? 'PASS' : 'NEEDS ATTENTION'));
  
  if (aiReviewResults.securityRisk) {
    console.log('  Security Risk: ' + aiReviewResults.securityRisk);
  }
  if (aiReviewResults.codeQuality) {
    console.log('  Code Quality:  ' + aiReviewResults.codeQuality);
  }
  
  console.log('-'.repeat(60));
  console.log('OVERALL:         ' + (verifyState.summary.overallPass ? 'PASS' : 'FAIL'));
  console.log('='.repeat(60));
  console.log('\nVerification state written to: ' + options.outputPath);
  
  if (aiReviewResults.needsAttention) {
    console.log('\nNote: AI review found issues that need attention.');
    console.log('Review details in: .workflow/state/ai-review.json');
  }
  
  // Exit with appropriate code
  process.exit(verifyState.summary.overallPass ? 0 : 1);
}

main().catch(function(error) {
  console.error('Verification failed:', error);
  process.exit(1);
});
