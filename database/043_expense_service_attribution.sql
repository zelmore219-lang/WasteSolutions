ALTER TABLE expenses ADD COLUMN order_id uuid REFERENCES orders(id),ADD COLUMN route_id uuid REFERENCES routes(id),
 ADD CHECK(num_nonnulls(order_id,route_id)<=1);
CREATE INDEX expense_order_attribution ON expenses(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX expense_route_attribution ON expenses(route_id) WHERE route_id IS NOT NULL;
