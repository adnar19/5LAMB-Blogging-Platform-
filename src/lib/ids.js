import { ulid } from 'ulid';

export const newId = () => ulid();

export const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const isUlid = (value) => typeof value === 'string' && ULID_REGEX.test(value);
