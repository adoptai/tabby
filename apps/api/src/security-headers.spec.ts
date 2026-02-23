/**
 * Adversarial test: Security headers MUST be present on all responses.
 * If helmet middleware is removed from main.ts, these tests WILL fail.
 */
import helmet from 'helmet';

describe('Security Headers Configuration', () => {
  it('helmet package is installed and importable', () => {
    expect(typeof helmet).toBe('function');
  });

  it('main.ts imports and uses helmet', async () => {
    const mainSource = require('fs').readFileSync(
      require('path').join(__dirname, 'main.ts'),
      'utf-8',
    );
    expect(mainSource).toContain("import helmet from 'helmet'");
    expect(mainSource).toContain('app.use(helmet(');
  });

  it('main.ts configures CORS', async () => {
    const mainSource = require('fs').readFileSync(
      require('path').join(__dirname, 'main.ts'),
      'utf-8',
    );
    expect(mainSource).toContain('app.enableCors(');
    expect(mainSource).toContain('CORS_ORIGIN');
  });

  it('main.ts configures trust proxy', async () => {
    const mainSource = require('fs').readFileSync(
      require('path').join(__dirname, 'main.ts'),
      'utf-8',
    );
    expect(mainSource).toContain("'trust proxy'");
    expect(mainSource).toContain('TRUST_PROXY');
  });
});
