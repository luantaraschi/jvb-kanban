'use strict';

const pdfParse = require('pdf-parse');
const { createClient } = require('@supabase/supabase-js');

const DEFAULT_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'ai-pending-documents';

let supabaseAdmin;
let bucketEnsurePromise;

function hasSupabaseStorageConfig() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function getSupabaseAdmin() {
  if (!hasSupabaseStorageConfig()) {
    const error = new Error('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sao obrigatorios para upload no Storage');
    error.status = 503;
    throw error;
  }

  if (!supabaseAdmin) {
    supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }

  return supabaseAdmin;
}

async function ensureStorageBucket() {
  if (!hasSupabaseStorageConfig()) return false;
  if (!bucketEnsurePromise) {
    bucketEnsurePromise = (async function ensureOnce() {
      const client = getSupabaseAdmin();
      const { data: buckets, error: listError } = await client.storage.listBuckets();
      if (listError) throw listError;

      const exists = (buckets || []).some((bucket) => bucket && bucket.name === DEFAULT_BUCKET);
      if (!exists) {
        const { error: createError } = await client.storage.createBucket(DEFAULT_BUCKET, {
          public: false,
          fileSizeLimit: '20MB'
        });
        if (createError && !/already exists/i.test(createError.message || '')) {
          throw createError;
        }
      }

      return true;
    })().catch((error) => {
      bucketEnsurePromise = null;
      throw error;
    });
  }

  return bucketEnsurePromise;
}

async function uploadPendingPdf(input) {
  if (!hasSupabaseStorageConfig()) {
    return {
      uploaded: false,
      bucket: null,
      path: null,
      publicUrl: null,
      storageStatus: 'not_configured'
    };
  }

  await ensureStorageBucket();
  const client = getSupabaseAdmin();
  const safeName = sanitizeFileName(input.filename || 'pendencias.pdf');
  const objectPath =
    'pending-documents/' +
    new Date().toISOString().slice(0, 10) + '/' +
    String(input.documentId || Date.now()) + '-' + safeName;

  const { error: uploadError } = await client.storage
    .from(DEFAULT_BUCKET)
    .upload(objectPath, input.buffer, {
      contentType: input.mimeType || 'application/pdf',
      upsert: true
    });

  if (uploadError) throw uploadError;

  return {
    uploaded: true,
    bucket: DEFAULT_BUCKET,
    path: objectPath,
    publicUrl: null,
    storageStatus: 'uploaded'
  };
}

async function extractPdfText(input) {
  const parsed = await pdfParse(input.buffer);
  return String(parsed && parsed.text ? parsed.text : '')
    .replace(/\u0000/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizeFileName(value) {
  const safe = String(value || 'arquivo.pdf')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return safe || 'arquivo.pdf';
}

module.exports = {
  DEFAULT_BUCKET,
  ensureStorageBucket,
  extractPdfText,
  hasSupabaseStorageConfig,
  uploadPendingPdf
};
