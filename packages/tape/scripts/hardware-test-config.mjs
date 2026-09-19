// Shared config for the OP-Z hardware test scripts.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BASE_URL = process.env.TAPE_TEST_URL ?? 'http://localhost:5173';
export const PROFILE_DIR = process.env.TAPE_TEST_PROFILE_DIR ?? path.join(__dirname, '..', '.playwright-profile');
