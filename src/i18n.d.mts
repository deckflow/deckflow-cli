import messages from "./messages.mjs";
export type MessageKey = keyof typeof messages;
export type Locale = "en" | "zh";
export type LanguagePreference = Locale | "auto";
export function systemLanguage(
  env?: NodeJS.ProcessEnv,
  fallback?: () => string,
): Locale;
export function savedLanguage(): LanguagePreference;
export function resolveLanguage(
  preference?: string,
  env?: NodeJS.ProcessEnv,
  saved?: string,
): Locale;
export function setLanguage(value: Locale): void;
export function getLanguage(): Locale;
export function t(key: MessageKey, values?: unknown[]): string;
export function localize(text: string): string;
