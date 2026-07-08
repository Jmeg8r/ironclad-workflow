#!/usr/bin/env node

/**
 * AI Code Review Script (Gemini)
 * ==============================
 * Sends code changes to Google Gemini for security and quality review.
 * 
 * Usage: node scripts/ai-review.js [options]
 * 
 * Options:
 *   --files <paths>    Comma-separated file paths to review
 *   --diff             Review git diff instead of full files
 *   --security-focus   Focus review on security concerns
 *   --output <path>    Output path for review results
 * 
 * Environment:
 *   GEMINI_API_KEY     Required. Your Google Gemini API key.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

// Configuration
const GEMINI_API_URL = 'generativelanguage.googleapis.com';
const GEMINI_MODEL = 'gemini-2.5-flash'; // Updated model name for 2026
const OUTPUT_PATH = '.workflow/state/ai-review.json';
const MAX_FILE_SIZE = 50000; // Characters per file

// Only these code extensions are ever sent to the model — no .css/.json (they
// add little to a security/quality review). Applied to BOTH auto-discovery and
// explicit --files input, so a caller can't smuggle e.g. secrets.json past it.
const REVIEWABLE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go', '.rs']);

function isReviewableSourceFile(filePath) {
  return REVIEWABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  useDiff: args.includes('--diff'),
  securityFocus: args.includes('--security-focus'),
  outputPath: OUTPUT_PATH,
  files: []
};

// Parse --files argument
const filesIndex = args.indexOf('--files');
if (filesIndex !== -1 && args[filesIndex + 1]) {
  options.files = args[filesIndex + 1].split(',').map(f => f.trim());
}

// Parse --output argument
const outputIndex = args.indexOf('--output');
if (outputIndex !== -1 && args[outputIndex + 1]) {
  options.outputPath = args[outputIndex + 1];
}

// Get API key from environment
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('ERROR: GEMINI_API_KEY environment variable is required.');
  console.error('Set it with: export GEMINI_API_KEY="your-api-key"');
  process.exit(1);
}

// Review prompts
const SECURITY_REVIEW_PROMPT = `You are a senior security engineer conducting a thorough code review. 
Analyze the following code for security vulnerabilities and concerns.

Focus on:
1. Input validation and sanitization
2. SQL injection, XSS, and other injection attacks
3. Authentication and authorization issues
4. Sensitive data exposure
5. Path traversal vulnerabilities
6. Insecure dependencies or patterns
7. Error handling that exposes sensitive information
8. Hardcoded secrets or credentials

For each issue found, provide:
- Severity: CRITICAL, HIGH, MEDIUM, or LOW
- Location: File and approximate line/function
- Description: What the issue is
- Recommendation: How to fix it

If no security issues are found, confirm the code appears secure and note any security best practices observed.

Respond in JSON format:
{
  "summary": "Overall security assessment",
  "issues": [
    {
      "severity": "HIGH",
      "location": "file.js:functionName",
      "description": "Description of issue",
      "recommendation": "How to fix"
    }
  ],
  "positives": ["Good practices observed"],
  "overallRisk": "LOW|MEDIUM|HIGH|CRITICAL"
}`;

const QUALITY_REVIEW_PROMPT = `You are a senior software engineer conducting a code review.
Analyze the following code for quality, maintainability, and best practices.

Focus on:
1. Code clarity and readability
2. Error handling completeness
3. Edge case handling
4. Performance concerns
5. Code organization and modularity
6. Naming conventions
7. Documentation and comments
8. Potential bugs or logic errors
9. Test coverage considerations

For each issue found, provide:
- Priority: HIGH, MEDIUM, or LOW
- Location: File and approximate line/function
- Description: What the issue is
- Suggestion: How to improve

Respond in JSON format:
{
  "summary": "Overall code quality assessment",
  "issues": [
    {
      "priority": "MEDIUM",
      "location": "file.js:functionName",
      "description": "Description of issue",
      "suggestion": "How to improve"
    }
  ],
  "strengths": ["Good practices observed"],
  "overallQuality": "EXCELLENT|GOOD|ACCEPTABLE|NEEDS_WORK"
}`;

// Utility functions

// Sanitize strings before logging to prevent log injection attacks
// (strips control characters that could manipulate terminal output)
function sanitizeForLog(value) {
  if (typeof value !== 'string') return String(value);
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\r]/g, '');
}

// Resolve the nearest existing ancestor of a path to its real (symlink-free)
// location. Used so containment checks can't be fooled by a symlink in the
// path, even when the leaf (e.g. a not-yet-created output file) doesn't exist.
function realpathNearest(targetPath) {
  let current = path.resolve(targetPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }
  return fs.realpathSync(current);
}

// Validate that a file path is within the project directory (symlink-aware)
function isPathWithinProject(filePath) {
  try {
    const projectRoot = fs.realpathSync(path.resolve('.'));
    const resolved = fs.realpathSync(path.resolve(filePath));
    return resolved === projectRoot || resolved.startsWith(projectRoot + path.sep);
  } catch (e) {
    // Path does not exist or cannot be resolved — treat as outside.
    return false;
  }
}

function getGitDiff() {
  try {
    // Get diff of staged and unstaged changes
    let diff = '';
    try {
      diff = execSync('git diff HEAD', { encoding: 'utf-8', maxBuffer: 1024 * 1024 });
    } catch (e) {
      // If HEAD doesn't exist (new repo), get all files
      diff = execSync('git diff --cached', { encoding: 'utf-8', maxBuffer: 1024 * 1024 });
    }
    return diff || 'No changes detected';
  } catch (error) {
    console.log('Git diff not available, will review specified files');
    return null;
  }
}

function findSourceFiles(baseDir) {
  const files = [];

  function walkDir(dir) {
    if (!fs.existsSync(dir)) return;

    // Skip unreadable directories (e.g. permission denied) rather than aborting
    // the whole review — the project-root fallback can reach dirs we can't read.
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      console.warn('Skipping unreadable directory ' + sanitizeForLog(dir) + ': ' + sanitizeForLog(error.message));
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }

      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.isFile()) {
        if (isReviewableSourceFile(entry.name)) {
          files.push(fullPath);
        }
      }
    }
  }

  // Prefer src/, but fall back to the whole project when it is absent — otherwise
  // a project without a src/ directory got an empty review that silently
  // "passed", and files outside src/ (e.g. tests) were never seen. Mirrors
  // findFiles() in verify.js.
  const srcDir = path.join(baseDir, 'src');
  if (fs.existsSync(srcDir)) {
    console.log('Scanning src/ for source files...');
    walkDir(srcDir);
  } else {
    console.log('No src/ directory found. Scanning current directory...');
    walkDir(baseDir);
  }

  return files.sort();
}

function readFilesContent(filePaths) {
  const contents = [];

  for (const filePath of filePaths) {
    // Enforce the code-only allowlist even for explicit --files input, so a
    // caller can't pass a .json/.css (or anything else) straight to the model.
    if (!isReviewableSourceFile(filePath)) {
      console.warn('Skipping non-code file: ' + sanitizeForLog(filePath));
      continue;
    }

    // Validate file path stays within project directory before reading
    if (!isPathWithinProject(filePath)) {
      console.warn('Skipping file outside project directory: ' + sanitizeForLog(filePath));
      continue;
    }

    try {
      let content = fs.readFileSync(filePath, 'utf-8');

      // Truncate very large files
      if (content.length > MAX_FILE_SIZE) {
        content = content.substring(0, MAX_FILE_SIZE) + '\n\n... [truncated] ...';
      }

      contents.push({
        path: filePath,
        content: content
      });
    } catch (error) {
      console.warn('Could not read ' + sanitizeForLog(filePath) + ': ' + sanitizeForLog(error.message));
    }
  }

  return contents;
}

// Sanitize file content for safe inclusion in API requests
// (validates text is printable UTF-8, strips null bytes)
function sanitizeFileContent(content) {
  if (typeof content !== 'string') return '';
  return content.replace(/\0/g, '');
}

function buildCodeContext(files, diff) {
  let context = '';

  if (diff && options.useDiff) {
    context = '## Git Diff (Changes to Review)\n\n```diff\n' + sanitizeFileContent(diff) + '\n```\n\n';
  }

  if (files.length > 0) {
    context += '## Source Files\n\n';
    for (const file of files) {
      const ext = path.extname(file.path).slice(1) || 'text';
      context += '### ' + sanitizeForLog(file.path) + '\n\n```' + ext + '\n' + sanitizeFileContent(file.content) + '\n```\n\n';
    }
  }

  return context;
}

async function callGemini(prompt, codeContext) {
  return new Promise((resolve, reject) => {
    const requestBody = JSON.stringify({
      contents: [{
        parts: [{
          text: prompt + '\n\n---\n\nCode to review:\n\n' + codeContext
        }]
      }],
      generationConfig: {
        temperature: 0.2,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 8192,
      }
    });

    const requestOptions = {
      hostname: GEMINI_API_URL,
      port: 443,
      // Pass the API key via header, not the query string, so it can't leak
      // into request logs, proxy logs, or process listings.
      path: '/v1beta/models/' + GEMINI_MODEL + ':generateContent',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
        'x-goog-api-key': API_KEY
      }
    };

    const req = https.request(requestOptions, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          
          if (response.error) {
            reject(new Error('Gemini API error: ' + response.error.message));
            return;
          }
          
          if (response.candidates && response.candidates[0] && 
              response.candidates[0].content && response.candidates[0].content.parts) {
            const text = response.candidates[0].content.parts[0].text;
            resolve(text);
          } else {
            reject(new Error('Unexpected response format from Gemini'));
          }
        } catch (e) {
          reject(new Error('Failed to parse Gemini response: ' + e.message));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error('Request failed: ' + error.message));
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Gemini API request timed out after 30 seconds'));
    });

    req.write(requestBody);
    req.end();
  });
}

function extractJsonFromResponse(response) {
  // Strategy 1: Try parsing the full response as JSON directly
  try {
    return JSON.parse(response.trim());
  } catch (e) {
    // Not pure JSON, try extraction strategies
  }

  // Strategy 2: Look for JSON inside a fenced code block (```json ... ``` or ``` ... ```)
  const fencedMatch = response.match(/```(?:json)?\s*\n(\{[\s\S]*?\})\s*\n```/);
  if (fencedMatch) {
    try {
      return JSON.parse(fencedMatch[1]);
    } catch (e) {
      // Fenced block wasn't valid JSON, continue
    }
  }

  // Strategy 3: Find balanced top-level braces by tracking depth
  const start = response.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    for (let i = start; i < response.length; i++) {
      if (response[i] === '{') depth++;
      else if (response[i] === '}') depth--;
      if (depth === 0) {
        try {
          return JSON.parse(response.substring(start, i + 1));
        } catch (e) {
          // Balanced braces but not valid JSON, continue
          break;
        }
      }
    }
  }

  return null;
}

// Parse and validate Gemini response, returning only expected fields
// (reconstructs a clean object to prevent untrusted data from flowing to file writes)
function parseGeminiResponse(response) {
  const parsed = extractJsonFromResponse(response);

  if (!parsed) {
    console.warn('Warning: Could not parse structured JSON from Gemini response');
    return {
      summary: sanitizeForLog(response.substring(0, 2000)),
      issues: [],
      raw: true
    };
  }

  // Reconstruct with only expected fields and safe string values
  const clean = {
    summary: typeof parsed.summary === 'string' ? String(parsed.summary) : '',
    issues: [],
    raw: false
  };

  if (parsed.overallRisk) clean.overallRisk = String(parsed.overallRisk);
  if (parsed.overallQuality) clean.overallQuality = String(parsed.overallQuality);
  if (Array.isArray(parsed.positives)) clean.positives = parsed.positives.map(String);
  if (Array.isArray(parsed.strengths)) clean.strengths = parsed.strengths.map(String);

  if (Array.isArray(parsed.issues)) {
    clean.issues = parsed.issues.map(function(issue) {
      return {
        severity: typeof issue.severity === 'string' ? String(issue.severity) : undefined,
        priority: typeof issue.priority === 'string' ? String(issue.priority) : undefined,
        location: typeof issue.location === 'string' ? String(issue.location) : '',
        description: typeof issue.description === 'string' ? String(issue.description) : '',
        recommendation: typeof issue.recommendation === 'string' ? String(issue.recommendation) : undefined,
        suggestion: typeof issue.suggestion === 'string' ? String(issue.suggestion) : undefined
      };
    });
  }

  return clean;
}

// Main review process
async function main() {
  console.log('='.repeat(60));
  console.log('AI CODE REVIEW (Gemini)');
  console.log('='.repeat(60));
  console.log('Timestamp: ' + new Date().toISOString());
  console.log('Model: ' + GEMINI_MODEL);
  console.log('');

  // Gather code to review
  let filesToReview = [];
  let gitDiff = null;

  if (options.files.length > 0) {
    // Use specified files
    filesToReview = options.files;
    console.log('Reviewing specified files: ' + filesToReview.join(', '));
  } else if (options.useDiff) {
    // Use git diff
    gitDiff = getGitDiff();
    if (!gitDiff || gitDiff === 'No changes detected') {
      console.log('No git changes detected, reviewing src/ files...');
      filesToReview = findSourceFiles('.');
    } else {
      console.log('Reviewing git diff...');
    }
  } else {
    // Default: review src/ files
    filesToReview = findSourceFiles('.');
    console.log('Found ' + filesToReview.length + ' source files to review');
  }

  // Read file contents
  const fileContents = readFilesContent(filesToReview);
  const codeContext = buildCodeContext(fileContents, gitDiff);

  if (!codeContext || codeContext.trim().length < 50) {
    console.log('No code found to review.');
    process.exit(0);
  }

  console.log('\nCode context size: ' + codeContext.length + ' characters');

  // Run reviews
  const results = {
    timestamp: new Date().toISOString(),
    model: GEMINI_MODEL,
    filesReviewed: filesToReview,
    usedDiff: options.useDiff && !!gitDiff,
    securityReview: null,
    qualityReview: null,
    summary: {
      securityRisk: 'UNKNOWN',
      codeQuality: 'UNKNOWN',
      passesReview: false
    }
  };

  // Security Review
  console.log('\n' + '-'.repeat(60));
  console.log('Running Security Review...');
  console.log('-'.repeat(60));
  
  try {
    const securityResponse = await callGemini(SECURITY_REVIEW_PROMPT, codeContext);
    results.securityReview = parseGeminiResponse(securityResponse);
    
    if (results.securityReview.overallRisk) {
      results.summary.securityRisk = results.securityReview.overallRisk;
      console.log('Security Risk: ' + sanitizeForLog(results.securityReview.overallRisk));
    }

    if (results.securityReview.issues && results.securityReview.issues.length > 0) {
      console.log('Security Issues Found: ' + results.securityReview.issues.length);
      for (const issue of results.securityReview.issues) {
        console.log('  [' + sanitizeForLog(issue.severity) + '] ' + sanitizeForLog(issue.location) + ': ' + sanitizeForLog(issue.description));
      }
    } else {
      console.log('No security issues found.');
    }
  } catch (error) {
    console.error('Security review failed: ' + sanitizeForLog(error.message));
    results.securityReview = { error: String(error.message) };
  }

  // Quality Review (unless security-only mode)
  if (!options.securityFocus) {
    console.log('\n' + '-'.repeat(60));
    console.log('Running Quality Review...');
    console.log('-'.repeat(60));
    
    try {
      const qualityResponse = await callGemini(QUALITY_REVIEW_PROMPT, codeContext);
      results.qualityReview = parseGeminiResponse(qualityResponse);
      
      if (results.qualityReview.overallQuality) {
        results.summary.codeQuality = results.qualityReview.overallQuality;
        console.log('Code Quality: ' + sanitizeForLog(results.qualityReview.overallQuality));
      }

      if (results.qualityReview.issues && results.qualityReview.issues.length > 0) {
        console.log('Quality Issues Found: ' + results.qualityReview.issues.length);
        for (const issue of results.qualityReview.issues) {
          console.log('  [' + sanitizeForLog(issue.priority) + '] ' + sanitizeForLog(issue.location) + ': ' + sanitizeForLog(issue.description));
        }
      } else {
        console.log('No quality issues found.');
      }
    } catch (error) {
      console.error('Quality review failed: ' + sanitizeForLog(error.message));
      results.qualityReview = { error: String(error.message) };
    }
  }

  // Determine if review passes
  const securityPass = !results.securityReview.overallRisk || 
                       ['LOW', 'MEDIUM'].includes(results.securityReview.overallRisk);
  const qualityPass = !results.qualityReview || 
                      !results.qualityReview.overallQuality ||
                      ['EXCELLENT', 'GOOD', 'ACCEPTABLE'].includes(results.qualityReview.overallQuality);
  
  results.summary.passesReview = securityPass && qualityPass;

  // Validate output path stays within project directory (symlink-aware).
  // If the file already exists, resolve the file itself — it could be a symlink
  // pointing outside the repo that writeFileSync would follow. Otherwise resolve
  // the nearest existing ancestor, since the output dir may not exist yet.
  const resolvedOutput = path.resolve(options.outputPath);
  let realProjectRoot;
  let realOutputTarget;
  try {
    realProjectRoot = fs.realpathSync(path.resolve('.'));
    realOutputTarget = fs.existsSync(resolvedOutput)
      ? fs.realpathSync(resolvedOutput)
      : realpathNearest(path.dirname(resolvedOutput));
  } catch (e) {
    console.error('ERROR: Could not resolve output path: ' + e.message);
    process.exit(1);
  }
  if (realOutputTarget !== realProjectRoot &&
      !realOutputTarget.startsWith(realProjectRoot + path.sep)) {
    console.error('ERROR: Output path must be within project directory');
    process.exit(1);
  }

  // Ensure output directory exists
  const outputDir = path.dirname(resolvedOutput);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write results (serialized from our own structured object, not raw API response)
  fs.writeFileSync(resolvedOutput, JSON.stringify(results, null, 2));

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('AI REVIEW SUMMARY');
  console.log('='.repeat(60));
  console.log('Security Risk:  ' + results.summary.securityRisk);
  console.log('Code Quality:   ' + results.summary.codeQuality);
  console.log('-'.repeat(60));
  console.log('REVIEW RESULT:  ' + (results.summary.passesReview ? 'PASS' : 'NEEDS ATTENTION'));
  console.log('='.repeat(60));
  console.log('\nReview results written to: ' + options.outputPath);

  // Exit with appropriate code
  process.exit(results.summary.passesReview ? 0 : 1);
}

main().catch(function(error) {
  console.error('AI Review failed:', error);
  process.exit(1);
});
