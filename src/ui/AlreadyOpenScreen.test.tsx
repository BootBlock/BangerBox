import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AlreadyOpenScreen } from './AlreadyOpenScreen';

describe('AlreadyOpenScreen (spec §8.1/§9.7)', () => {
  it('blocks until the owning tab releases, then offers take-over', async () => {
    let release: () => void = () => {};
    const whenReleased = new Promise<void>((resolve) => {
      release = resolve;
    });

    render(<AlreadyOpenScreen whenReleased={whenReleased} />);
    const button = screen.getByTestId('already-open-takeover');
    expect(button).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('already open in another tab');

    release();
    await screen.findByText('Use BangerBox here');
    expect(screen.getByTestId('already-open-takeover')).toBeEnabled();
  });
});
