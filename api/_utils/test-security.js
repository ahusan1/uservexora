/**
 * Security Testing Utility
 * 
 * This script helps test your security implementations locally.
 * Run: node api/_utils/test-security.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from .env file manually
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, '../../.env');

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const [key, ...valueParts] = line.split('=');
    const value = valueParts.join('=').trim();
    if (key && !key.startsWith('#') && value) {
      process.env[key.trim()] = value;
    }
  });
}

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';

console.log('🛡️  Security Implementation Test Suite\n');
console.log(`Testing: ${BASE_URL}\n`);

// Test 1: Rate Limiting
async function testRateLimit() {
  console.log('📊 Test 1: Rate Limiting');
  console.log('Sending 105 requests to check rate limiting...');
  
  let successCount = 0;
  let rateLimitedCount = 0;
  let lastRemainingHeader = null;

  for (let i = 1; i <= 105; i++) {
    try {
      const response = await fetch(`${BASE_URL}/api/product/test`);
      const remaining = response.headers.get('X-RateLimit-Remaining');
      const limit = response.headers.get('X-RateLimit-Limit');
      
      if (response.status === 200) {
        successCount++;
        if (i % 20 === 0) {
          console.log(`  ✓ Request ${i}: Success (Remaining: ${remaining}/${limit})`);
        }
        lastRemainingHeader = remaining;
      } else if (response.status === 429) {
        rateLimitedCount++;
        const retryAfter = response.headers.get('Retry-After');
        console.log(`  ⚠ Request ${i}: Rate limited (Retry after: ${retryAfter}s)`);
      }
    } catch (err) {
      console.log(`  ✗ Request ${i}: Error -`, err.message);
    }
  }
  
  console.log('\n  Results:');
  console.log(`  ✓ Successful requests: ${successCount}`);
  console.log(`  ⚠ Rate limited requests: ${rateLimitedCount}`);
  console.log(`  ✅ Rate limiting: ${rateLimitedCount > 0 ? 'WORKING' : 'NOT WORKING'}`);
  console.log('');
}

// Test 2: CORS
async function testCORS() {
  console.log('🌐 Test 2: CORS Configuration');
  
  const testOrigins = [
    { origin: 'https://plusvexora.vercel.app', shouldAllow: true },
    { origin: 'https://evil-site.com', shouldAllow: false },
    { origin: 'http://localhost:3000', shouldAllow: true },
  ];
  
  for (const test of testOrigins) {
    try {
      const response = await fetch(`${BASE_URL}/api/product/test`, {
        method: 'OPTIONS',
        headers: {
          'Origin': test.origin,
          'Access-Control-Request-Method': 'GET',
        }
      });
      
      const allowedOrigin = response.headers.get('Access-Control-Allow-Origin');
      const allowed = allowedOrigin === test.origin;
      
      if (allowed && test.shouldAllow) {
        console.log(`  ✓ ${test.origin}: Correctly allowed`);
      } else if (!allowed && !test.shouldAllow) {
        console.log(`  ✓ ${test.origin}: Correctly blocked`);
      } else {
        console.log(`  ✗ ${test.origin}: Unexpected result (Expected: ${test.shouldAllow ? 'allow' : 'block'})`);
      }
    } catch (err) {
      console.log(`  ✗ ${test.origin}: Test failed -`, err.message);
    }
  }
  
  console.log('');
}

// Test 3: Authentication
async function testAuthentication() {
  console.log('🔐 Test 3: Authentication');
  
  // Test without token
  try {
    const response = await fetch(`${BASE_URL}/api/_examples/authenticated-endpoint`);
    const data = await response.json();
    
    if (response.status === 401) {
      console.log('  ✓ Unauthenticated request: Correctly rejected (401)');
    } else {
      console.log('  ✗ Unauthenticated request: Should be rejected but got', response.status);
    }
  } catch (err) {
    console.log('  ⚠ Authentication endpoint not found (create from template to test)');
  }
  
  // Test with invalid token
  try {
    const response = await fetch(`${BASE_URL}/api/_examples/authenticated-endpoint`, {
      headers: {
        'Authorization': 'Bearer invalid-token-12345'
      }
    });
    
    if (response.status === 401) {
      console.log('  ✓ Invalid token: Correctly rejected (401)');
    } else {
      console.log('  ✗ Invalid token: Should be rejected but got', response.status);
    }
  } catch (err) {
    console.log('  ⚠ Authentication endpoint not found');
  }
  
  console.log('\n  Note: To test with valid token, log in and get token from:');
  console.log('  localStorage.getItem("sb-xxx-auth-token")');
  console.log('');
}

// Test 4: Environment Configuration
function testEnvironmentConfig() {
  console.log('⚙️  Test 4: Environment Configuration');
  
  const requiredVars = [
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'ALLOWED_ORIGINS',
  ];
  
  const optionalVars = [
    'SUPABASE_SERVICE_ROLE_KEY',
    'RATE_LIMIT_WINDOW_MS',
    'RATE_LIMIT_MAX_REQUESTS',
    'RATE_LIMIT_MAX_REQUESTS_AUTH',
  ];
  
  let allSet = true;
  
  console.log('  Required:');
  for (const varName of requiredVars) {
    const isSet = !!process.env[varName];
    console.log(`  ${isSet ? '✓' : '✗'} ${varName}: ${isSet ? 'Set' : 'MISSING'}`);
    if (!isSet) allSet = false;
  }
  
  console.log('\n  Optional:');
  for (const varName of optionalVars) {
    const isSet = !!process.env[varName];
    console.log(`  ${isSet ? '✓' : '○'} ${varName}: ${isSet ? 'Set' : 'Using default'}`);
  }
  
  console.log(`\n  ✅ Configuration: ${allSet ? 'READY' : 'INCOMPLETE - Set missing variables'}`);
  console.log('');
}

// Test 5: Response Headers
async function testSecurityHeaders() {
  console.log('📋 Test 5: Security Headers');
  
  try {
    const response = await fetch(`${BASE_URL}/api/product/test`);
    
    const headers = {
      'X-RateLimit-Limit': response.headers.get('X-RateLimit-Limit'),
      'X-RateLimit-Remaining': response.headers.get('X-RateLimit-Remaining'),
      'X-RateLimit-Reset': response.headers.get('X-RateLimit-Reset'),
      'Access-Control-Allow-Origin': response.headers.get('Access-Control-Allow-Origin'),
    };
    
    for (const [header, value] of Object.entries(headers)) {
      if (value) {
        console.log(`  ✓ ${header}: ${value}`);
      } else {
        console.log(`  ○ ${header}: Not present`);
      }
    }
  } catch (err) {
    console.log('  ✗ Failed to fetch headers:', err.message);
  }
  
  console.log('');
}

// Run all tests
async function runTests() {
  console.log('Starting security tests...\n');
  
  testEnvironmentConfig();
  await testSecurityHeaders();
  await testCORS();
  await testAuthentication();
  await testRateLimit();
  
  console.log('═══════════════════════════════════════════════');
  console.log('✅ Security test suite completed!');
  console.log('═══════════════════════════════════════════════');
  console.log('\nFor production testing:');
  console.log('  BASE_URL=https://yourdomain.com node api/_utils/test-security.js');
}

// Entry point
runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
