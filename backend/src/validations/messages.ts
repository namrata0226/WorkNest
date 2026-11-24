import { z } from 'zod';

const num = (n: number | bigint) => Number(n).toLocaleString('en-IN');

/**
 * Plain-language messages for any check that does not set its own, replacing Zod's defaults
 * such as "Too big: expected string to have <=1000 characters".
 */
export function friendlyMessage(issue: z.core.$ZodRawIssue): string | undefined {
  switch (issue.code) {
    case 'too_big': {
      const max = num(issue.maximum as number);
      if (issue.origin === 'string') return `Use ${max} characters or fewer`;
      if (issue.origin === 'array' || issue.origin === 'set') return `Choose no more than ${max}`;
      return issue.inclusive === false ? `Must be less than ${max}` : `Must be ${max} or less`;
    }
    case 'too_small': {
      const min = Number(issue.minimum);
      if (issue.origin === 'string') return min <= 1 ? 'This field is required' : `Use at least ${num(min)} characters`;
      if (issue.origin === 'array' || issue.origin === 'set') return min <= 1 ? 'Choose at least one' : `Choose at least ${num(min)}`;
      return issue.inclusive === false ? `Must be more than ${num(min)}` : `Must be ${num(min)} or more`;
    }
    case 'invalid_type':
      if (issue.input === undefined || issue.input === null || issue.input === '') return 'This field is required';
      if (issue.expected === 'number' || issue.expected === 'int') return 'Enter a number';
      return 'This value is not valid';
    case 'invalid_format':
      if (issue.format === 'email') return 'Enter a valid email address';
      return 'This is not in the expected format';
    case 'invalid_value':
      return 'Choose one of the listed options';
    case 'not_multiple_of':
      return `Must be in steps of ${issue.divisor}`;
    case 'unrecognized_keys':
      return `Unexpected field: ${issue.keys.join(', ')}`;
    default:
      return undefined;
  }
}

z.config({ customError: friendlyMessage });
