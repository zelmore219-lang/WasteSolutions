import { configureHostedWeb } from "./hosted-web";
import { NestExpressApplication } from "@nestjs/platform-express";
import { ProviderSettings } from "./provider-settings";
import { StripeRefunds } from "./stripe-refunds";
import { ServiceTiming } from "./service-timing";
import { PayableAdjustments } from "./payable-adjustments";
import { EquipmentStorage } from "./equipment-storage";
import { MaterialStock } from "./material-stock";
import { FeePolicies } from "./fee-policies";
import { Pricebooks } from "./pricebooks";
import { RoadPlanning } from "./road-planning";
import { DriverActionReview } from "./driver-action-review";
import { DriverTasks } from "./driver-tasks";
import { DisposalLoads } from "./disposal-loads";
import { ServiceCalendar } from "./service-calendar";
import { MonthlyBilling } from "./monthly-billing";
import { OrderTasks } from "./order-tasks";
import { QuickBooks } from "./quickbooks";
import { Notifications } from "./notifications";
import { configuredAdapters, deliverBatch } from "./delivery";
import { BillingControls } from "./billing-controls";
import { StripeProfiles } from "./stripe-profiles";
import { Automation } from "./automation";
import { verifyIdentity } from "./identity";
import { Portal } from "./portal";
import { Changes } from "./changes";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { Media } from "./media";
import { DriverTracking } from "./driver-tracking";
import "reflect-metadata";
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  HttpException,
  Controller,
  Get,
  Sse,
  Inject,
  Query,
  Post,
  Body,
  Param,
  Headers,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
  Module,
  UseGuards,
  ServiceUnavailableException,
} from "@nestjs/common";
import { assertIdentityConfiguration } from "./identity-config";
import { NestFactory } from "@nestjs/core";
import { Pool } from "pg";
import { applicationDefault, initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { Operations, Actor } from "./domain";
import { Workflows } from "./workflows";
import { Dispatch } from "./dispatch";
import { Customers } from "./customers";
import { Imports } from "./imports";
import { Reports } from "./reports";
import { Administration } from "./administration";
import { StripePayments } from "./stripe-payments";
import { Finance } from "./finance";
import { Station } from "./station";
import { Rentals } from "./rentals";
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});
export const operations = new Operations(pool);
const providerSettings = new ProviderSettings(operations);
const driverActionReview = new DriverActionReview(operations);
const driverTasks = new DriverTasks(operations);
const disposalLoads = new DisposalLoads(operations);
const serviceCalendar = new ServiceCalendar(operations);
const monthlyBilling = new MonthlyBilling(operations);
const orderTasks = new OrderTasks(operations);
const quickbooks = new QuickBooks(operations);
const notificationService = new Notifications(operations);
const portal = new Portal(operations);
const media = new Media(operations);
const driverTracking = new DriverTracking(operations);
const workflows = new Workflows(operations);
const rentals = new Rentals(operations);
const finance = new Finance(operations);
const station = new Station(operations);
const stripePayments = new StripePayments(operations, finance);
const stripeRefunds = new StripeRefunds(operations);
stripePayments.refundEvents = (event) => stripeRefunds.event(event);
const billingControls = new BillingControls(operations);
const stripeProfiles = new StripeProfiles(operations, (event, type) =>
  stripePayments.process(event, type),
);
stripePayments.profileEvents = (event) => stripeProfiles.event(event);
const automation = new Automation(
  operations,
  workflows,
  billingControls,
  stripeProfiles,
);
const administration = new Administration(operations);
const reports = new Reports(operations);
const imports = new Imports(operations);
const customers = new Customers(operations);
const dispatch = new Dispatch(operations);
const roads = new RoadPlanning(operations);
const pricebooks = new Pricebooks(operations);
const feePolicies = new FeePolicies(operations);
const materialStock = new MaterialStock(operations);
const equipmentStorage = new EquipmentStorage(operations);
const serviceTiming = new ServiceTiming(operations);
@Injectable()
export class IdentityGuard implements CanActivate {
  private windows = new Map<string, { started: number; count: number }>();
  private checks = 0;
  private limit(id: string, maximum: number) {
    const now = Date.now(),
      old = this.windows.get(id);
    const entry =
      old && now - old.started < 60000 ? old : { started: now, count: 0 };
    entry.count++;
    this.windows.set(id, entry);
    if (++this.checks % 500 === 0)
      for (const [key, value] of this.windows)
        if (now - value.started >= 60000) this.windows.delete(key);
    if (entry.count > maximum)
      throw new HttpException(
        "Request limit reached; retry after a minute",
        429,
      );
  }

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    const identity = await verifyIdentity(req.headers.authorization);
    const actor = (
      await pool.query(
        "SELECT id,role,customer_id FROM employees WHERE firebase_uid=$1 AND active",
        [identity.uid],
      )
    ).rows[0];
    if (!actor) throw new ForbiddenException("Account is not provisioned");
    if (
      ["owner", "manager"].includes(actor.role) &&
      !identity.firebase?.sign_in_second_factor
    )
      throw new ForbiddenException("Administrator MFA required");
    await providerSettings.refreshRuntime();
    this.limit(actor.id, 300);
    if (req.method === "POST" && req.url.startsWith("/api/payments/"))
      this.limit(actor.id + ":payments", 10);
    req.actor = actor;
    return true;
  }
}
const payableAdjustments = new PayableAdjustments(operations);
@Controller("api")
class HealthController {
  @Get("accounting/quickbooks/callback") async quickBooksCallback(
    @Query() q: unknown,
    @Res() response: any,
  ) {
    await providerSettings.refreshRuntime();
    await quickbooks.callback(q);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    return response
      .type("text/plain")
      .send(
        "QuickBooks connected. Return to CoreWaste, open QuickBooks, and review the company before activating exports.",
      );
  }
  @Post("payments/stripe/webhook") async stripeWebhook(
    @Req() r: { rawBody?: Buffer },
    @Headers("stripe-signature") signature: string,
  ) {
    await providerSettings.refreshRuntime();
    return stripePayments.webhook(r.rawBody || Buffer.alloc(0), signature);
  }
  @Get("public/client-config") publicClientConfiguration(
    @Res({ passthrough: true }) response: any,
  ) {
    response.setHeader("Cache-Control", "no-store");
    return providerSettings.publicClientConfig();
  }
  @Get("public/company") publicCompany() {
    return portal.publicCompany();
  }
  @Post("public/inquiries") publicInquiry(@Body() b: unknown) {
    return portal.inquiry(b);
  }
  @Post("portal/registration") async portalRegistration(
    @Headers("authorization") header: string,
    @Body() b: unknown,
  ) {
    return portal.registration(await verifyIdentity(header), b);
  }
  @Get("portal/registration") async portalRegistrationStatus(
    @Headers("authorization") header: string,
  ) {
    return portal.registrationStatus(await verifyIdentity(header));
  }
  @Get("health") async health() {
    await pool.query("SELECT 1");
    return { status: "ok", service: "CoreWaste API" };
  }
}
@Controller("api")
@UseGuards(IdentityGuard)
class OperationsController {
  @Get("settings/providers") providerConfiguration(@Req() r: { actor: Actor }) {
    return providerSettings.list(r.actor);
  }
  @Post("settings/providers/:provider") saveProviderConfiguration(
    @Req() r: { actor: Actor },
    @Param("provider") provider: string,
    @Headers("idempotency-key") key: string,
    @Body() body: unknown,
  ) {
    return providerSettings.save(r.actor, key, provider, body);
  }

  constructor(@Inject(Changes) private readonly changes: Changes) {}
  @Sse("events") changeEvents(@Req() r: { actor: Actor }) {
    return this.changes.events(r.actor);
  }
  @Get("requests") requests(@Req() r: { actor: Actor }) {
    return workflows.requests(r.actor);
  }
  @Post("requests") request(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Body() b: unknown,
  ) {
    return workflows.request(r.actor, key, b);
  }
  @Post("requests/:id/convert") convert(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return workflows.convert(r.actor, key, id, b);
  }
  @Get("routes/:id/road-planning") roadData(
    @Req() r: { actor: Actor },
    @Param("id") id: string,
  ) {
    return roads.data(r.actor, id);
  }
  @Post("locations/:id/routing-pin") routingPin(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return roads.pin(r.actor, key, id, b);
  }
  @Post("trucks/:id/routing-profile") routingProfile(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return roads.profile(r.actor, key, id, b);
  }
  @Post("routes/:id/road-plans") roadPlan(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return roads.create(r.actor, key, id, b);
  }
  @Post("road-plans/:id/apply") applyRoadPlan(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
  ) {
    return roads.apply(r.actor, key, id);
  }
  @Get("routes") routes(@Req() r: { actor: Actor }) {
    return workflows.routes(r.actor);
  }
  @Post("routes") route(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Body() b: unknown,
  ) {
    return workflows.route(r.actor, key, b);
  }
  @Get("agreements") agreements(@Req() r: { actor: Actor }) {
    return workflows.agreements(r.actor);
  }
  @Post("agreements") agreement(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Body() b: unknown,
  ) {
    return workflows.agreement(r.actor, key, b);
  }
  @Post("agreements/generate") generate(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Body() b: unknown,
  ) {
    return workflows.generate(r.actor, key, b);
  }
  @Get("equipment/yards") equipmentYards(@Req() r: { actor: Actor }) {
    return equipmentStorage.yards(r.actor);
  }
  @Post("equipment/yards") equipmentYardCreate(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Body() b: unknown,
  ) {
    return equipmentStorage.createYard(r.actor, key, b);
  }
  @Post("equipment/yards/:id/update") equipmentYardUpdate(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return equipmentStorage.updateYard(r.actor, key, id, b);
  }
  @Get("equipment/:id/events") equipmentEvents(
    @Req() r: { actor: Actor },
    @Param("id") id: string,
    @Query() query: unknown,
  ) {
    return equipmentStorage.events(r.actor, id, query);
  }
  @Post("equipment/:id/observe-legacy") observeLegacyEquipment(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return equipmentStorage.observeLegacyPlacement(r.actor, key, id, body);
  }
  @Get("equipment/:id/history") equipmentHistory(
    @Req() r: { actor: Actor },
    @Param("id") id: string,
  ) {
    return equipmentStorage.history(r.actor, id);
  }
  @Post("equipment/:id/move") equipmentMove(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return equipmentStorage.move(r.actor, key, id, b);
  }
  @Post("equipment/:id/place") equipmentPlace(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return equipmentStorage.place(r.actor, key, id, b);
  }
  @Post("equipment/:id/recover") equipmentRecover(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return equipmentStorage.recover(r.actor, key, id, b);
  }
  @Post("equipment/:id/status") equipmentStatus(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return equipmentStorage.status(r.actor, key, id, b);
  }
  @Get("containers") containers(@Req() r: { actor: Actor }) {
    return rentals.containers(r.actor);
  }
  @Get("containers/availability") availableContainers(
    @Req() r: { actor: Actor },
    @Query() q: unknown,
  ) {
    return rentals.availability(r.actor, q);
  }
  @Post("containers") createContainer(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return rentals.createContainer(r.actor, k, b);
  }
  @Get("rentals") rentals(@Req() r: { actor: Actor }) {
    return rentals.list(r.actor);
  }
  @Get("rentals/:id") rentalDetail(
    @Req() r: { actor: Actor },
    @Param("id") id: string,
  ) {
    return rentals.detail(r.actor, id);
  }
  @Post("rentals") reserve(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return rentals.reserve(r.actor, k, b);
  }
  @Post("rentals/:id/extend") rentalExtend(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return rentals.extend(r.actor, k, id, b);
  }
  @Post("rentals/:id/exchange") rentalExchange(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return rentals.exchange(r.actor, k, id, b);
  }
  @Post("rentals/:id/cancel") rentalCancel(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return rentals.cancel(r.actor, k, id, b);
  }
  @Post("rentals/:id/disposal") rentalDisposal(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return rentals.disposal(r.actor, k, id, b);
  }
  @Post("rentals/:id/invoice") rentalInvoice(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
  ) {
    return rentals.invoice(r.actor, k, id);
  }
  @Get("invoices/:id") invoiceDetail(
    @Req() r: { actor: Actor },
    @Param("id") id: string,
  ) {
    return finance.detail(r.actor, id);
  }
  @Post("invoices/:id/payments") receivePayment(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return finance.payment(r.actor, k, id, b);
  }
  @Post("payments/:id/refunds") refund(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return finance.refund(r.actor, k, id, b);
  }
  @Post("expenses/:id/credits") creditVendorBill(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return payableAdjustments.credit(r.actor, key, id, b);
  }
  @Post("expenses/:id/payments/:paymentId/reverse") reverseVendorPayment(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Param("paymentId") paymentId: string,
    @Body() b: unknown,
  ) {
    return payableAdjustments.reversePayment(r.actor, key, id, paymentId, b);
  }
  @Post("provider-refunds/external/payments/:id") adoptExternalPaymentRefund(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return stripeRefunds.adoptExternal(r.actor, key, "payment", id, body);
  }
  @Post("provider-refunds/external/credits/:id") adoptExternalCreditRefund(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return stripeRefunds.adoptExternal(r.actor, key, "credit", id, body);
  }
  @Get("provider-refunds") providerRefunds(
    @Req() r: { actor: Actor },
    @Query() query: unknown,
  ) {
    return stripeRefunds.list(r.actor, query);
  }
  @Post("payments/:id/provider-refunds") requestStripeRefund(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return stripeRefunds.request(r.actor, key, "payment", id, body);
  }
  @Post("credits/:id/provider-refunds") requestStripeCreditRefund(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return stripeRefunds.request(r.actor, key, "credit", id, body);
  }
  @Post("provider-refunds/:id/cancel") cancelStripeRefund(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
  ) {
    return stripeRefunds.cancel(r.actor, key, id);
  }
  @Post("provider-refunds/:id/submit") submitStripeRefund(
    @Req() r: { actor: Actor },
    @Param("id") id: string,
  ) {
    return stripeRefunds.submit(r.actor, id);
  }
  @Post("provider-refunds/:id/reconcile") reconcileStripeRefund(
    @Req() r: { actor: Actor },
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return stripeRefunds.reconcile(r.actor, id, body);
  }
  @Get("expenses/:id") expenseHistory(
    @Req() r: { actor: Actor },
    @Param("id") id: string,
  ) {
    return finance.expenseHistory(r.actor, id);
  }
  @Post("expenses/:id/payments") expensePayment(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return finance.expensePayment(r.actor, key, id, b);
  }
  @Get("expenses") expenses(@Req() r: { actor: Actor }) {
    return finance.expenses(r.actor);
  }
  @Post("expenses") expense(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return finance.expense(r.actor, k, b);
  }
  @Get("customers/:id/statement") statement(
    @Req() r: { actor: Actor },
    @Param("id") id: string,
  ) {
    return finance.statement(r.actor, id);
  }
  @Get("notifications") notifications(@Req() r: { actor: Actor }) {
    return finance.notifications(r.actor);
  }
  @Post("notifications/:id/read") readNotification(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
  ) {
    return finance.markRead(r.actor, k, id);
  }
  @Get("stock/materials") stockList(@Req() r: { actor: Actor }) {
    return materialStock.list(r.actor);
  }
  @Get("stock/materials/:id") stockHistory(
    @Req() r: { actor: Actor },
    @Param("id") id: string,
  ) {
    return materialStock.history(r.actor, id);
  }
  @Post("stock/materials") stockCreate(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Body() b: unknown,
  ) {
    return materialStock.create(r.actor, key, b);
  }
  @Post("stock/materials/:id/count") stockCount(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return materialStock.count(r.actor, key, id, b);
  }
  @Post("stock/transfers") stockTransfer(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Body() b: unknown,
  ) {
    return materialStock.transfer(r.actor, key, b);
  }
  @Get("station/materials") materials(@Req() r: { actor: Actor }) {
    return station.materials(r.actor);
  }
  @Post("station/materials") material(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return station.material(r.actor, k, b);
  }
  @Get("station/tickets") scaleTickets(@Req() r: { actor: Actor }) {
    return station.tickets(r.actor);
  }
  @Post("station/tickets") openScaleTicket(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return station.open(r.actor, k, b);
  }
  @Post("station/tickets/:id/weigh") weigh(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return station.weigh(r.actor, k, id, b);
  }
  @Post("station/tickets/:id/invoice") stationInvoice(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
  ) {
    return station.invoice(r.actor, k, id);
  }
  @Get("station/reconciliation") reconcileStation(
    @Req() r: { actor: Actor },
    @Query("date") date: string,
  ) {
    return station.reconcile(r.actor, date);
  }
  @Post("payments/checkout") checkout(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return stripePayments.checkout(r.actor, k, b);
  }
  @Get("credits") credits(@Req() r: { actor: Actor }) {
    return finance.credits(r.actor);
  }
  @Post("credits/:id/apply") applyCredit(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return finance.applyCredit(r.actor, k, id, b);
  }
  @Get("company") adminCompany(@Req() r: { actor: Actor }) {
    return administration.company(r.actor);
  }
  @Get("employees") adminEmployees(@Req() r: { actor: Actor }) {
    return administration.employees(r.actor);
  }
  @Get("fleet/trucks") adminTrucks(@Req() r: { actor: Actor }) {
    return administration.trucks(r.actor);
  }
  @Get("fleet/inspections") adminInspections(@Req() r: { actor: Actor }) {
    return administration.inspections(r.actor);
  }
  @Get("fleet/maintenance") adminMaintenance(@Req() r: { actor: Actor }) {
    return administration.maintenance(r.actor);
  }
  @Get("audit") adminAudit(@Req() r: { actor: Actor }) {
    return administration.audit(r.actor);
  }
  @Get("messages") adminMessages(@Req() r: { actor: Actor }) {
    return administration.messages(r.actor);
  }
  @Get("messages/contacts") adminContacts(@Req() r: { actor: Actor }) {
    return administration.contacts(r.actor);
  }
  @Post("company") adminUpdatecompany(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return administration.updateCompany(r.actor, k, b);
  }
  @Post("employees") adminCreateemployee(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return administration.createEmployee(r.actor, k, b);
  }
  @Post("fleet/trucks") adminTruck(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return administration.truck(r.actor, k, b);
  }
  @Post("fleet/inspections") adminInspect(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return administration.inspect(r.actor, k, b);
  }
  @Post("fleet/maintenance") adminSchedulemaintenance(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return administration.scheduleMaintenance(r.actor, k, b);
  }
  @Post("messages/:id/read") adminReadMessage(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
  ) {
    return administration.readMessage(r.actor, k, id);
  }
  @Post("messages") adminMessage(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return administration.message(r.actor, k, b);
  }
  @Post("employees/:id") adminUpdateemployee(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return administration.updateEmployee(r.actor, k, id, b);
  }
  @Post("fleet/trucks/:id/status") adminTruckstatus(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return administration.truckStatus(r.actor, k, id, b);
  }
  @Post("fleet/maintenance/:id/complete") adminCompletemaintenance(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return administration.completeMaintenance(r.actor, k, id, b);
  }
  @Get("reports/:name") report(
    @Req() r: { actor: Actor },
    @Param("name") name: string,
    @Query() q: unknown,
  ) {
    return reports.run(r.actor, name, q);
  }
  @Get("reports/:name/export/:format") async exportReport(
    @Req() r: { actor: Actor },
    @Param("name") name: string,
    @Param("format") format: string,
    @Query() q: unknown,
    @Res() res: any,
  ) {
    const report = await reports.run(r.actor, name, q);
    if (format !== "csv" && format !== "pdf")
      throw new (require("@nestjs/common").BadRequestException)(
        "Export format must be csv or pdf",
      );
    res.setHeader(
      "Content-Type",
      format === "csv" ? "text/csv; charset=utf-8" : "application/pdf",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="CoreWaste-${report.name}.${format}"`,
    );
    res.send(
      format === "csv" ? reports.csv(report.rows) : await reports.pdf(report),
    );
  }
  @Get("imports") importList(@Req() r: { actor: Actor }) {
    return imports.list(r.actor);
  }
  @Get("imports/:id") importDetail(
    @Req() r: { actor: Actor },
    @Param("id") id: string,
  ) {
    return imports.detail(r.actor, id);
  }
  @Post("imports/preview") importPreview(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return imports.preview(r.actor, k, b);
  }
  @Post("imports/:id/apply") importApply(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return imports.apply(r.actor, k, id, b);
  }
  @Post("imports/:id/rollback") importRollback(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return imports.rollback(r.actor, k, id, b);
  }
  @Post("customers/:id") updateCustomer(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return customers.update(r.actor, k, id, b);
  }
  @Get("customers/:id/notes") customerNotes(
    @Req() r: { actor: Actor },
    @Param("id") id: string,
  ) {
    return customers.notes(r.actor, id);
  }
  @Post("customers/:id/notes") customerNote(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return customers.note(r.actor, k, id, b);
  }
  @Post("routes/:id/update") updateRoute(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return dispatch.updateRoute(r.actor, k, id, b);
  }
  @Post("orders/:id/reschedule") rescheduleOrder(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return dispatch.reschedule(r.actor, k, id, b);
  }
  @Post("attachments")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: 10485760, files: 1, fields: 8, fieldSize: 4000 },
    }),
  )
  uploadAttachment(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return media.upload(r.actor, k, b, file);
  }
  @Get("attachments/entity/:kind/:id") attachmentList(
    @Req() r: { actor: Actor },
    @Param("kind") kind: string,
    @Param("id") id: string,
  ) {
    return media.list(r.actor, kind, id);
  }
  @Get("attachments/:id/download") async downloadAttachment(
    @Req() r: { actor: Actor },
    @Param("id") id: string,
    @Res() res: any,
  ) {
    const file = await media.download(r.actor, id);
    res.setHeader("Content-Type", file.content_type);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${file.filename}"`,
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.send(file.data);
  }
  @Post("drivers/location") recordLocation(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return driverTracking.record(r.actor, k, b);
  }
  @Get("drivers/locations") driverLocations(@Req() r: { actor: Actor }) {
    return driverTracking.latest(r.actor);
  }
  @Get("sync/exceptions") syncExceptions(@Req() r: { actor: Actor }) {
    return driverTracking.exceptions(r.actor);
  }
  @Post("sync/exceptions") submitSyncException(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return driverTracking.exception(r.actor, k, b);
  }
  @Post("sync/exceptions/:id/resolve") resolveSyncException(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return driverTracking.resolve(r.actor, k, id, b);
  }
  @Get("inquiries") publicInquiries(@Req() r: { actor: Actor }) {
    return portal.inquiries(r.actor);
  }
  @Post("inquiries/:id/convert") convertInquiry(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return portal.convert(r.actor, k, id, b);
  }
  @Get("portal/registrations") portalRegistrations(@Req() r: { actor: Actor }) {
    return portal.registrations(r.actor);
  }
  @Post("portal/registrations/:id/review") reviewRegistration(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return portal.review(r.actor, k, id, b);
  }
  @Post("invoices/:id/credits") invoiceCredit(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return billingControls.creditInvoice(r.actor, k, id, b);
  }
  @Post("credits/:id/refunds") creditRefund(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return billingControls.refundCredit(r.actor, k, id, b);
  }
  @Get("payments/profile") paymentProfile(@Req() r: { actor: Actor }) {
    return stripeProfiles.profile(r.actor);
  }
  @Post("payments/setup") setupPaymentMethod(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return stripeProfiles.setup(r.actor, k, b);
  }
  @Post("payments/autopay") autopaySettings(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return stripeProfiles.settings(r.actor, k, b);
  }
  @Get("automation") automationHistory(@Req() r: { actor: Actor }) {
    return automation.history(r.actor);
  }
  @Post("automation/run") async runAutomation(@Req() r: { actor: Actor }) {
    return automation.run(r.actor, await automation.today());
  }
  @Get("notifications/preferences") notificationPreferences(
    @Req() r: { actor: Actor },
  ) {
    return notificationService.preferences(r.actor);
  }
  @Post("notifications/preferences") updateNotificationPreferences(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return notificationService.savePreferences(r.actor, k, b);
  }
  @Get("notifications/templates") notificationTemplates(
    @Req() r: { actor: Actor },
  ) {
    return notificationService.templates(r.actor);
  }
  @Post("notifications/templates") saveNotificationTemplate(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return notificationService.template(r.actor, k, b);
  }
  @Get("notifications/deliveries") notificationDeliveries(
    @Req() r: { actor: Actor },
  ) {
    return notificationService.deliveries(r.actor);
  }
  @Post("notifications/deliveries/:id/retry") retryNotification(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return notificationService.retry(r.actor, k, id, b);
  }
  @Post("notifications/process") async processNotifications(
    @Req() r: { actor: Actor },
  ) {
    if (!["owner", "manager"].includes(r.actor.role))
      throw new ForbiddenException();
    return deliverBatch(pool, configuredAdapters());
  }
  @Get("accounting/quickbooks") quickBooksStatus(@Req() r: { actor: Actor }) {
    return quickbooks.status(r.actor);
  }
  @Post("accounting/quickbooks/connect") quickBooksConnect(
    @Req() r: { actor: Actor },
  ) {
    return quickbooks.connect(r.actor);
  }
  @Post("accounting/quickbooks/activate") quickBooksActivate(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return quickbooks.activate(r.actor, k, b);
  }
  @Get("accounting/quickbooks/accounts") quickBooksAccounts(
    @Req() r: { actor: Actor },
  ) {
    return quickbooks.accounts(r.actor);
  }
  @Post("accounting/quickbooks/mappings") quickBooksMapping(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return quickbooks.mapping(r.actor, k, b);
  }
  @Post("accounting/quickbooks/customers") quickBooksCustomer(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return quickbooks.customerMapping(r.actor, k, b);
  }
  @Post("accounting/quickbooks/export") quickBooksExport(
    @Req() r: { actor: Actor },
  ) {
    return quickbooks.exportJournals(r.actor);
  }
  @Post("orders/:id/tasks") addOrderTask(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return orderTasks.add(r.actor, k, id, b);
  }
  @Post("orders/:id/tasks/:taskId/complete") completeOrderTask(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Param("taskId") taskId: string,
    @Body() b: unknown,
  ) {
    return orderTasks.complete(r.actor, k, id, taskId, b);
  }
  @Get("billing/contract-recognition") pendingContractRecognition(
    @Req() r: { actor: Actor },
  ) {
    return monthlyBilling.pendingRecognition(r.actor);
  }
  @Post("billing/contract-periods/:id/recognize") recognizeContract(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
  ) {
    return monthlyBilling.recognize(r.actor, key, id);
  }
  @Get("billing/monthly") monthlyDue(@Req() r: { actor: Actor }) {
    return monthlyBilling.due(r.actor);
  }
  @Post("agreements/:id/monthly-invoice") monthlyInvoice(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return monthlyBilling.invoice(r.actor, k, id, b);
  }
  @Post("agreements/:id/end") endAgreement(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return monthlyBilling.end(r.actor, k, id, b);
  }
  @Get("service-calendar") calendar(@Req() r: { actor: Actor }) {
    return serviceCalendar.list(r.actor);
  }
  @Post("service-calendar/zones") saveServiceZone(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return serviceCalendar.zone(r.actor, k, b);
  }
  @Post("service-calendar/locations") assignServiceZone(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return serviceCalendar.assignLocation(r.actor, k, b);
  }
  @Post("service-calendar/changes") saveCalendarChange(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return serviceCalendar.change(r.actor, k, b);
  }
  @Get("service-calendar/preview") calendarPreview(
    @Req() r: { actor: Actor },
    @Query() q: unknown,
  ) {
    return serviceCalendar.preview(r.actor, q);
  }
  @Post("service-calendar/apply") applyCalendar(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return serviceCalendar.apply(r.actor, k, b);
  }
  @Get("disposal-loads") outstandingDisposal(@Req() r: { actor: Actor }) {
    return disposalLoads.list(r.actor);
  }
  @Post("disposal-loads/:id/assign") assignDisposal(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return disposalLoads.assign(r.actor, k, id, b);
  }
  @Post("disposal-loads/:id/unable") unableToDump(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return disposalLoads.unable(r.actor, k, id, b);
  }
  @Get("driver-tasks") standaloneTasks(@Req() r: { actor: Actor }) {
    return driverTasks.list(r.actor);
  }
  @Post("driver-tasks") createStandaloneTask(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return driverTasks.create(r.actor, k, b);
  }
  @Post("driver-tasks/:id/assign") assignStandaloneTask(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return driverTasks.assign(r.actor, k, id, b);
  }
  @Post("driver-tasks/:id/status") standaloneTaskStatus(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return driverTasks.status(r.actor, k, id, b);
  }
  @Post("driver-tasks/:id/cancel") cancelStandaloneTask(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return driverTasks.cancel(r.actor, k, id, b);
  }
  @Get("driver-actions/reviews") driverActionEvidence(
    @Req() r: { actor: Actor },
  ) {
    return driverActionReview.list(r.actor);
  }
  @Post("driver-actions/review") submitDriverActionEvidence(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Body() b: unknown,
  ) {
    return driverActionReview.submit(r.actor, k, b);
  }
  @Post("driver-actions/reviews/:id/resolve") resolveDriverActionEvidence(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return driverActionReview.resolve(r.actor, k, id, b);
  }
  @Post("orders/:id/priority") changeOrderPriority(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return dispatch.priority(r.actor, k, id, b);
  }
  @Post("orders/:id/cancel") cancelServiceOrder(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return dispatch.cancel(r.actor, k, id, b);
  }
  @Post("orders/:id/calendar-move") moveCalendarOrder(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") k: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return dispatch.move(r.actor, k, id, b);
  }
  @Get("me") me(@Req() r: { actor: Actor }) {
    return r.actor;
  }
  @Get("customers") customers(@Req() r: { actor: Actor }, @Query() q: unknown) {
    return operations.customers(r.actor, q);
  }
  @Post("customers") createCustomer(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Body() b: unknown,
  ) {
    return operations.createCustomer(r.actor, key, b);
  }
  @Get("customers/:id/fee-policies") feePolicyList(
    @Req() r: { actor: Actor },
    @Param("id") id: string,
  ) {
    return feePolicies.list(r.actor, id);
  }
  @Post("fee-policies") feePolicyCreate(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Body() b: unknown,
  ) {
    return feePolicies.create(r.actor, key, b);
  }
  @Post("fee-policies/:id/update") feePolicyUpdate(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return feePolicies.update(r.actor, key, id, b);
  }
  @Get("customers/:id/pricebooks") pricebookList(
    @Req() r: { actor: Actor },
    @Param("id") id: string,
  ) {
    return pricebooks.list(r.actor, id);
  }
  @Post("pricebooks") pricebookCreate(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Body() b: unknown,
  ) {
    return pricebooks.create(r.actor, key, b);
  }
  @Post("pricebooks/:id/update") pricebookUpdate(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return pricebooks.update(r.actor, key, id, b);
  }
  @Get("customers/:id/locations") locations(
    @Req() r: { actor: Actor },
    @Param("id") id: string,
  ) {
    return operations.locations(r.actor, id);
  }
  @Post("customers/:id/locations") createLocation(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return operations.createLocation(r.actor, key, id, b);
  }
  @Post("orders/:id/service-timing") serviceWindow(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return serviceTiming.update(r.actor, key, id, body);
  }
  @Get("orders") orders(@Req() r: { actor: Actor }, @Query() q: unknown) {
    return operations.orders(r.actor, q);
  }
  @Post("orders") createOrder(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Body() b: unknown,
  ) {
    return operations.createOrder(r.actor, key, b);
  }
  @Post("orders/:id/assign") assign(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return operations.assign(r.actor, key, id, b);
  }
  @Post("orders/:id/status") status(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return operations.transition(r.actor, key, id, b);
  }
  @Post("orders/:id/invoice") invoice(
    @Req() r: { actor: Actor },
    @Headers("idempotency-key") key: string,
    @Param("id") id: string,
  ) {
    return operations.invoice(r.actor, key, id);
  }
  @Get("invoices") invoices(@Req() r: { actor: Actor }) {
    return operations.invoices(r.actor);
  }
  @Get("resources") resources(@Req() r: { actor: Actor }) {
    return operations.resources(r.actor);
  }
}
@Module({
  controllers: [HealthController, OperationsController],
  providers: [
    IdentityGuard,
    { provide: Changes, useFactory: () => new Changes(pool) },
  ],
})
class AppModule {}
export async function createApp() {
  assertIdentityConfiguration();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ["error", "warn", "log"],
    rawBody: true,
  });
  app.use(helmet());
  app.use(
    "/api/public/inquiries",
    rateLimit({
      windowMs: 3600000,
      limit: 5,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 10000,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  if (process.env.TRUST_PROXY_HOPS) {
    const hops = Number(process.env.TRUST_PROXY_HOPS);
    if (!Number.isInteger(hops) || hops < 1 || hops > 3)
      throw new Error(
        "TRUST_PROXY_HOPS must be an explicitly configured hop count from 1 to 3",
      );
    app.getHttpAdapter().getInstance().set("trust proxy", hops);
  }
  app.enableCors({
    origin: process.env.WEB_ORIGIN || "http://localhost:5173",
    allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
  });
  await configureHostedWeb(app);
  app.enableShutdownHooks();
  return app;
}
