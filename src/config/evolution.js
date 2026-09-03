import dotenv from 'dotenv';

dotenv.config();

export const EVOLUTION_URL = process.env.EVOLUTION_URL || 'http://localhost:8080';
export const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
export const EVOLUTION_WEBHOOK_URL = process.env.EVOLUTION_WEBHOOK_URL || '';
export const SINGLE_BUSINESS_ID = process.env.SINGLE_BUSINESS_ID || 'lashesbyshazz';
