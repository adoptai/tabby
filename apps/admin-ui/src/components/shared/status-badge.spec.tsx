import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from './status-badge';

describe('StatusBadge', () => {
  it('renders the value', () => {
    render(<StatusBadge value="HEALTHY" />);
    expect(screen.getByText('HEALTHY')).toBeInTheDocument();
  });

  it('renders N/A for null', () => {
    render(<StatusBadge value={null} />);
    expect(screen.getByText('N/A')).toBeInTheDocument();
  });

  it('renders N/A for undefined', () => {
    render(<StatusBadge value={undefined} />);
    expect(screen.getByText('N/A')).toBeInTheDocument();
  });

  it('applies success color for HEALTHY', () => {
    render(<StatusBadge value="HEALTHY" />);
    const el = screen.getByText('HEALTHY');
    expect(el.style.color).toBe('var(--success)');
  });

  it('applies success color for PASS', () => {
    render(<StatusBadge value="PASS" />);
    const el = screen.getByText('PASS');
    expect(el.style.color).toBe('var(--success)');
  });

  it('applies error color for FAILED', () => {
    render(<StatusBadge value="FAILED" />);
    const el = screen.getByText('FAILED');
    expect(el.style.color).toBe('var(--error)');
  });

  it('applies error color for AUTH_FAIL', () => {
    render(<StatusBadge value="AUTH_FAIL" />);
    const el = screen.getByText('AUTH_FAIL');
    expect(el.style.color).toBe('var(--error)');
  });

  it('applies warning color for LOGIN_NEEDED', () => {
    render(<StatusBadge value="LOGIN_NEEDED" />);
    const el = screen.getByText('LOGIN_NEEDED');
    expect(el.style.color).toBe('var(--warning)');
  });

  it('applies violet color for LOGIN_IN_PROGRESS', () => {
    render(<StatusBadge value="LOGIN_IN_PROGRESS" />);
    const el = screen.getByText('LOGIN_IN_PROGRESS');
    expect(el.style.color).toBe('var(--violet)');
  });

  it('applies neutral color for TERMINATED', () => {
    render(<StatusBadge value="TERMINATED" />);
    const el = screen.getByText('TERMINATED');
    expect(el.style.color).toBe('var(--neutral)');
  });

  it('applies neutral fallback color for unknown status', () => {
    render(<StatusBadge value="SOME_UNKNOWN_STATE" />);
    const el = screen.getByText('SOME_UNKNOWN_STATE');
    expect(el.style.color).toBe('var(--neutral)');
  });

  it('forwards className to the element', () => {
    render(<StatusBadge value="HEALTHY" className="my-custom-class" />);
    const el = screen.getByText('HEALTHY');
    expect(el.className).toContain('my-custom-class');
  });
});
