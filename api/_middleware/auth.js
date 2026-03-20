/**
 * Production-Grade Authentication & Authorization Middleware
 * 
 * Implements JWT validation using Supabase Auth:
 * - Token extraction from Authorization header
 * - JWT signature verification
 * - Token expiration checks
 * - Role-based access control (RBAC)
 * - Secure error handling
 * 
 * Security Benefits:
 * - Prevents unauthorized access to protected resources
 * - Validates token integrity and authenticity
 * - Enforces principle of least privilege via RBAC
 * - Protects against token tampering
 */

import { createClient } from '@supabase/supabase-js';

// Environment configuration - NEVER hardcode secrets
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // For admin operations
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('Missing required environment variables: SUPABASE_URL or SUPABASE_ANON_KEY');
}

// Create Supabase client for auth validation
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Service role client for elevated operations (use sparingly)
const supabaseAdmin = SUPABASE_SERVICE_ROLE_KEY 
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

/**
 * Extract JWT token from Authorization header
 */
function extractToken(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  
  if (!authHeader) {
    return null;
  }
  
  // Support both "Bearer TOKEN" and "TOKEN" formats
  const parts = authHeader.split(' ');
  return parts.length === 2 ? parts[1] : authHeader;
}

/**
 * Verify JWT token and return user data
 * 
 * @param {string} token - JWT token
 * @returns {Object|null} User data or null if invalid
 */
export async function verifyToken(token) {
  if (!token) return null;
  
  try {
    const { data, error } = await supabase.auth.getUser(token);
    
    if (error || !data?.user) {
      console.error('Token verification failed:', error?.message);
      return null;
    }
    
    return data.user;
  } catch (err) {
    console.error('Token verification error:', err);
    return null;
  }
}

/**
 * Get user profile with role information
 * 
 * @param {string} userId - User ID
 * @returns {Object|null} User profile with role
 */
export async function getUserProfile(userId) {
  if (!userId) return null;
  
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, email, role, status')
      .eq('id', userId)
      .single();
    
    if (error || !data) {
      console.error('Profile fetch failed:', error?.message);
      return null;
    }
    
    return data;
  } catch (err) {
    console.error('Profile fetch error:', err);
    return null;
  }
}

/**
 * Authentication Middleware
 * 
 * Validates JWT token and attaches user to request
 * 
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @param {Object} options - Middleware options
 * @returns {Object|null} User object or null
 */
export async function authenticate(req, res, options = {}) {
  const { optional = false } = options;
  
  const token = extractToken(req);
  
  if (!token) {
    if (optional) {
      req.user = null;
      return null;
    }
    
    res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required. Please provide a valid access token.',
      }
    });
    return null;
  }
  
  const user = await verifyToken(token);
  
  if (!user) {
    if (optional) {
      req.user = null;
      return null;
    }
    
    res.status(401).json({
      error: {
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired access token.',
      }
    });
    return null;
  }
  
  // Attach user to request for downstream use
  req.user = user;
  return user;
}

/**
 * Authorization Middleware (Role-Based Access Control)
 * 
 * Checks if authenticated user has required role
 * 
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @param {Array<string>} allowedRoles - Array of allowed roles
 * @returns {Object|null} User profile or null
 */
export async function authorize(req, res, allowedRoles = []) {
  if (!req.user) {
    res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required.',
      }
    });
    return null;
  }
  
  const profile = await getUserProfile(req.user.id);
  
  if (!profile) {
    res.status(403).json({
      error: {
        code: 'FORBIDDEN',
        message: 'Unable to verify user permissions.',
      }
    });
    return null;
  }

  const normalizedProfile = { ...profile, role: 'user' };
  
  // User-only mode: reject endpoints that request non-user roles.
  if (allowedRoles.length > 0 && !allowedRoles.includes('user')) {
    res.status(403).json({
      error: {
        code: 'INSUFFICIENT_PERMISSIONS',
        message: 'This endpoint is unavailable in user-only mode.',
        requiredRole: allowedRoles,
        userRole: 'user',
      }
    });
    return null;
  }
  
  // Check if account is active
  if (profile.status === 'banned' || profile.status === 'suspended') {
    res.status(403).json({
      error: {
        code: 'ACCOUNT_SUSPENDED',
        message: 'Your account has been suspended. Please contact support.',
      }
    });
    return null;
  }
  
  req.userProfile = normalizedProfile;
  return normalizedProfile;
}

/**
 * Combined middleware: authenticate + authorize
 * 
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @param {Object} options - { roles: string[], optional: boolean }
 * @returns {Object|null} User profile or null
 */
export async function requireAuth(req, res, options = {}) {
  const { roles = [], optional = false } = options;
  
  const user = await authenticate(req, res, { optional });
  
  if (!user) {
    return null;
  }
  
  return await authorize(req, res, roles);
}

/**
 * Get Supabase admin client (service role)
 * Use with extreme caution - bypasses RLS
 */
export function getAdminClient() {
  if (!supabaseAdmin) {
    throw new Error('Service role key not configured');
  }
  return supabaseAdmin;
}
