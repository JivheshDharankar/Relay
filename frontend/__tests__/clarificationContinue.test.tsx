import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FailureExperienceCard } from '@/components/mission/FailureExperienceCard';

const PROMPT = '2 kg moong dal and 10 cheese balls';

function baseProps() {
  return {
    prompt: PROMPT,
    errorCode: 'MISSING_UNIT',
    errorMessage: '10 cheese balls — what unit should I use?',
    clarification: true,
    onRetry: vi.fn(),
    onReturnToCommandCenter: vi.fn(),
  };
}

describe('FailureExperienceCard clarification continuation', () => {
  it('renders inline amend-and-continue editor with the original prompt prefilled', () => {
    render(<FailureExperienceCard {...baseProps()} onContinueMission={vi.fn()} />);
    const editor = screen.getByLabelText(/your mission continues from here/i);
    expect((editor as HTMLTextAreaElement).value).toBe(PROMPT);
    expect(screen.getByRole('button', { name: /continue mission/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /edit & retry request/i })).toBeNull();
  });

  it('submits only the amended text to onContinueMission', () => {
    const onContinueMission = vi.fn();
    render(<FailureExperienceCard {...baseProps()} onContinueMission={onContinueMission} />);
    const editor = screen.getByLabelText(/your mission continues from here/i);
    fireEvent.change(editor, { target: { value: '2 kg moong dal and 10 packs cheese balls' } });
    fireEvent.click(screen.getByRole('button', { name: /continue mission/i }));
    expect(onContinueMission).toHaveBeenCalledTimes(1);
    expect(onContinueMission).toHaveBeenCalledWith('2 kg moong dal and 10 packs cheese balls');
  });

  it('falls back to legacy retry buttons without onContinueMission', () => {
    render(<FailureExperienceCard {...baseProps()} />);
    expect(screen.queryByLabelText(/your mission continues from here/i)).toBeNull();
    expect(screen.getByRole('button', { name: /edit & retry request/i })).toBeDefined();
  });
});
