ALTER TABLE service_agreements ADD COLUMN billing_alignment text NOT NULL DEFAULT 'calendar' CHECK(billing_alignment IN ('calendar','anniversary')),
 ADD COLUMN billing_cycle_months integer NOT NULL DEFAULT 1 CHECK(billing_cycle_months IN (1,3,12)),
 ADD CHECK(billing_mode='monthly' OR (billing_alignment='calendar' AND billing_cycle_months=1)),
 ADD CHECK(monthly_rate_cents IS NULL OR monthly_rate_cents::bigint*billing_cycle_months<=100000000);
ALTER TABLE monthly_billing_periods ADD COLUMN billing_alignment text NOT NULL DEFAULT 'calendar',
 ADD COLUMN billing_cycle_months integer NOT NULL DEFAULT 1,
 ADD COLUMN full_period_cents integer CHECK(full_period_cents BETWEEN 0 AND 100000000);
-- Keep the original anniversary day, including across February and leap years.
CREATE FUNCTION contract_cycle_next(period_start date,alignment text,cycle_length integer,anchor date) RETURNS date LANGUAGE sql IMMUTABLE STRICT AS $$
 WITH target AS (SELECT (date_trunc('month',period_start::timestamp)+make_interval(months=>cycle_length))::date AS first_day)
 SELECT first_day + LEAST(CASE WHEN alignment='calendar' THEN 1 ELSE EXTRACT(day FROM anchor)::integer END,EXTRACT(day FROM (first_day+interval '1 month - 1 day'))::integer)-1 FROM target
$$;
