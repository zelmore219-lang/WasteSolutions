import { providerValue } from "./provider-runtime";
import {
  BadGatewayException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { fetch, EnvHttpProxyAgent } from "undici";
import { z } from "zod";
export const position = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-85).max(85),
]);
export type Position = z.infer<typeof position>;
export type RoadInput = {
  origin: Position;
  destination: Position;
  departure_time: string;
  optimize: boolean;
};
export type RoadStop = {
  id: string;
  longitude: number;
  latitude: number;
  depends_on_parent: boolean;
  parent_order_id: string | null;
};
export type RoadProfile = {
  height_cm: number;
  width_cm: number;
  length_cm: number;
  gross_weight_kg: number;
  weight_per_axle_kg: number;
};
export type RoadResult = {
  order_ids: string[];
  distance_m: number;
  duration_s: number;
  leg_durations_s?: number[];
  geometry: Position[][];
  provider: string;
};
export interface RoadProvider {
  configured(): boolean;
  plan(
    input: RoadInput,
    stops: RoadStop[],
    profile: RoadProfile,
  ): Promise<RoadResult>;
}
const dispatcher = new EnvHttpProxyAgent();
// REST wire contracts verified against @aws-sdk/client-geo-routes 3.1164.0 generated service models.
// API-key authorization is supported directly by Geo Routes; SigV4 credentials are not fabricated.
export type RoadTransport = (
  path: "/v2/optimize-waypoints" | "/v2/routes",
  body: unknown,
) => Promise<unknown>;
export class AmazonRoadProvider implements RoadProvider {
  constructor(private readonly transport?: RoadTransport) {}
  configured() {
    return Boolean(
      this.transport ||
      (providerValue("ROUTING_API_KEY") &&
        /^[a-z]{2}-[a-z]+-\d$/.test(providerValue("ROUTING_REGION") || "")),
    );
  }
  private async request(
    path: "/v2/optimize-waypoints" | "/v2/routes",
    body: unknown,
  ) {
    if (this.transport) return this.transport(path, body);
    if (!this.configured())
      throw new ServiceUnavailableException("Road routing is not configured");
    const url = new URL(
      "https://routes.geo." +
        providerValue("ROUTING_REGION") +
        ".amazonaws.com" +
        path,
    );
    url.searchParams.set("key", providerValue("ROUTING_API_KEY")!);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        dispatcher,
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Error("provider response");
      }
      const reader = response.body?.getReader();
      if (!reader) throw Error("empty response");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 8 * 1024 * 1024) throw Error("oversized response");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new BadGatewayException(
        "Road provider could not return a verified route; no stop changes were applied",
      );
    }
  }
  async plan(
    input: RoadInput,
    stops: RoadStop[],
    profile: RoadProfile,
  ): Promise<RoadResult> {
    const truck = {
      TruckType: "StraightTruck",
      Height: profile.height_cm,
      Width: profile.width_cm,
      Length: profile.length_cm,
      GrossWeight: profile.gross_weight_kg,
      WeightPerAxle: profile.weight_per_axle_kg,
    };
    const common = {
      Origin: input.origin,
      Destination: input.destination,
      DepartureTime: input.departure_time,
      TravelMode: "Truck",
      Traffic: { Usage: "UseTrafficData" },
    };
    let ordered = stops;
    if (input.optimize) {
      // Linked work is deliberately excluded until the provider's numeric precedence indexing is independently verified.
      if (stops.some((s) => s.depends_on_parent))
        throw new ServiceUnavailableException(
          "Optimize linked work manually; road preview supports the saved stop order",
        );
      const raw = await this.request("/v2/optimize-waypoints", {
        ...common,
        OriginOptions: { Id: "depot-start" },
        DestinationOptions: { Id: "depot-end" },
        TravelModeOptions: {
          Truck: {
            TruckType: truck.TruckType,
            Height: truck.Height,
            Width: truck.Width,
            Length: truck.Length,
            GrossWeight: truck.GrossWeight,
          },
        },
        OptimizeSequencingFor: "FastestRoute",
        Waypoints: stops.map((s) => ({
          Id: s.id,
          Position: [s.longitude, s.latitude],
        })),
      });
      const parsed = z
        .object({
          ImpedingWaypoints: z.array(z.unknown()).max(0),
          OptimizedWaypoints: z.array(z.object({ Id: z.string() })).min(1),
        })
        .safeParse(raw);
      if (!parsed.success)
        throw new BadGatewayException(
          "Road optimization has missing stops or unsatisfied constraints",
        );
      const ids = parsed.data.OptimizedWaypoints.map((s) => s.Id);
      if (ids[0] === "depot-start") ids.shift();
      if (ids.at(-1) === "depot-end") ids.pop();
      if (
        ids.length !== stops.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !stops.some((s) => s.id === id))
      )
        throw new BadGatewayException(
          "Road provider returned an invalid stop sequence",
        );
      ordered = ids.map((id) => stops.find((s) => s.id === id)!);
    }
    const raw = await this.request("/v2/routes", {
      ...common,
      TravelModeOptions: { Truck: truck },
      Waypoints: ordered.map((s) => ({ Position: [s.longitude, s.latitude] })),
      LegGeometryFormat: "Simple",
      LegAdditionalFeatures: ["Summary", "TruckRoadTypes"],
      MaxAlternatives: 0,
      OptimizeRoutingFor: "FastestRoute",
    });
    const response = z
      .object({
        Notices: z.array(z.unknown()).max(0),
        Routes: z
          .array(
            z.object({
              Summary: z.object({
                Distance: z.number().finite().nonnegative(),
                Duration: z.number().finite().nonnegative(),
              }),
              Legs: z
                .array(
                  z.object({
                    TravelMode: z.literal("Truck"),
                    Type: z.literal("Vehicle"),
                    Geometry: z.object({
                      LineString: z.array(position).min(2).max(100000),
                    }),
                    VehicleLegDetails: z.object({
                      Notices: z.array(z.unknown()).max(0),
                      Summary: z
                        .object({
                          Overview: z.object({
                            Duration: z.number().finite().nonnegative(),
                          }),
                        })
                        .optional(),
                    }),
                  }),
                )
                .length(stops.length + 1),
            }),
          )
          .length(1),
      })
      .safeParse(raw);
    if (!response.success)
      throw new BadGatewayException(
        "Road provider reported restrictions, missing geometry, or an unsupported route; no changes were applied",
      );
    const route = response.data.Routes[0];
    return {
      order_ids: ordered.map((s) => s.id),
      distance_m: route.Summary.Distance,
      duration_s: route.Summary.Duration,
      ...(route.Legs.every((l) => l.VehicleLegDetails.Summary?.Overview)
        ? {
            leg_durations_s: route.Legs.map(
              (l) => l.VehicleLegDetails.Summary!.Overview.Duration,
            ),
          }
        : {}),
      geometry: route.Legs.map((l) => l.Geometry.LineString),
      provider: "amazon-location-v2",
    };
  }
}
