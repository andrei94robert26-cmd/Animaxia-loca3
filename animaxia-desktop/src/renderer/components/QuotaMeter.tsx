/**
 * components/QuotaMeter.tsx — AI quota display (plan · used/limit per day).
 * Every /api/ai/* response carries `quota: { plan, used, limit, perMinute }`.
 */

import React from 'react';
import type { AiCloudQuota } from '../api/ai';

export function QuotaMeter({ quota }: { quota: AiCloudQuota }): React.JSX.Element {
  const used = Math.max(0, Number(quota.used) || 0);
  const limit = Math.max(1, Number(quota.limit) || 1);
  const percent = Math.min(100, Math.round((used / limit) * 100));
  const low = percent >= 80;

  return (
    <div className="quota" role="status" aria-label={`AI quota: ${used} of ${limit} used today`}>
      <div className="quota__row">
        <span>
          AI quota — <span className="quota__strong">{quota.plan || 'free'}</span> plan
        </span>
        <span className={low ? 'quota__strong' : undefined} style={low ? { color: 'var(--amber)' } : undefined}>
          {used}/{limit} today
        </span>
      </div>
      <div
        className="quota__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
      >
        <div className={`quota__fill${low ? ' quota__fill--low' : ''}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export default QuotaMeter;
