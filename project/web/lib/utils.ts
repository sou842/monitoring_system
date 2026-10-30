import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Joins class names and lets later Tailwind classes override earlier ones (used by the shadcn / AI Elements components). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
