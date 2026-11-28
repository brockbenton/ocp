import { describe, it, expect } from 'vitest';
import {
  renderSemesterBadgeSvg,
  renderFoundingBadgeSvg,
  semesterArtUrl,
  foundingBadgeUrl,
} from '../src/services/art.service';

describe('renderSemesterBadgeSvg', () => {
  it('is deterministic and semester-specific', () => {
    expect(renderSemesterBadgeSvg('Spring 2026')).toBe(renderSemesterBadgeSvg('Spring 2026'));
    expect(renderSemesterBadgeSvg('Spring 2026')).not.toBe(renderSemesterBadgeSvg('Fall 2025'));
  });

  it('escapes XML in the semester label (no SVG injection)', () => {
    const svg = renderSemesterBadgeSvg('<script>&"');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('is an svg document', () => {
    expect(renderSemesterBadgeSvg('X').startsWith('<svg')).toBe(true);
  });
});

describe('founding badge', () => {
  it('renders the only member badge: attendance tiers are retired', () => {
    expect(renderFoundingBadgeSvg()).toContain('Founding Member');
  });
});

describe('asset URLs', () => {
  it('use PUBLIC_API_URL and the expected paths', () => {
    expect(semesterArtUrl('Spring 2026')).toBe('http://localhost:3001/api/v1/art/Spring%202026');
    expect(foundingBadgeUrl()).toBe('http://localhost:3001/api/v1/badge/founding');
  });
});
