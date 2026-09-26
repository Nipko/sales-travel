import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from '@sales-travel/validation';
import {
  HOTEL_PROVIDER_FACTORIES,
  HOTEL_PROVIDER_FLAGS,
  type HotelProviderCapabilities,
  type HotelProviderFactory,
  type HotelProviderRegistration,
  type HotelProviderResolution,
  type ResolvedHotelProvider,
} from './hotel-provider.types.js';
import {
  CallPolicySchema,
  ProviderAccountIncompleteError,
  ProviderAccountNotAllowedError,
  ProviderNotAvailableError,
  type CallPolicy,
  type ProviderErrorContext,
  type ProviderFlagsPort,
  type SkippedProvider,
  type UnavailableProvider,
} from './provider.types.js';

/**
 * Proveedores de hoteles a los que la plataforma presta SUS credenciales cuando el tenant no
 * tiene ni hereda una cuenta.
 *
 * Sólo Despegar, que es como opera hoy la vertical: sacarlo de aquí dejaría sin hoteles a todo
 * tenant sin cuenta propia. Un proveedor nuevo no entra por defecto: prestar la cuenta de la
 * plataforma significa consultas y reservas facturadas a quien no las pidió.
 */
const DEFAULT_PLATFORM_HOTEL_PROVIDERS = 'despegar-hotels';

const CodeListSchema = z.array(z.string().min(1));
const PolicyOverridesSchema = z.record(CallPolicySchema);

function parseCodes(raw: string): string[] {
  return CodeListSchema.parse(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * `HOTEL_PROVIDER_CALL_POLICIES=code:always,otro:opt-in`. Se valida al arrancar: un valor mal
 * escrito tiene que tumbar el despliegue, no convertirse en un proveedor que deja de llamarse
 * sin que nadie lo note.
 */
function parsePolicyOverrides(raw: string): Record<string, CallPolicy> {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf(':');
      return [pair.slice(0, idx).trim(), pair.slice(idx + 1).trim()] as const;
    });
  return PolicyOverridesSchema.parse(Object.fromEntries(entries));
}

type HotelProviderResolutionOutcome =
  | { readonly ok: true; readonly provider: ResolvedHotelProvider }
  | { readonly ok: false; readonly absence: UnavailableProvider };

/**
 * Registry de proveedores de hoteles por tenant. Espejo de `FlightProviderRegistry`.
 *
 * Hasta ahora `HotelsService` inyectaba el factory de Despegar y fijaba su código en una
 * constante: un segundo proveedor no tenía dónde registrarse. Acá se resuelve, por tenant, qué
 * proveedores de hoteles están habilitados, con qué credenciales, qué saben hacer y cuándo se
 * les puede llamar.
 *
 * Es una copia y no una instancia de un registry genérico a propósito: el de vuelos tiene suites
 * grandes detrás y un umbral de cobertura propio, y generalizarlo movía código que genera
 * ingresos para ganar unas doscientas líneas.
 *
 * Lee sus propias variables de entorno (`PLATFORM_DEFAULT_HOTEL_PROVIDERS`,
 * `HOTEL_PROVIDER_CALL_POLICIES`) y nunca las de vuelos.
 */
@Injectable()
export class HotelProviderRegistry {
  private readonly logger = new Logger(HotelProviderRegistry.name);
  private readonly factories: readonly HotelProviderFactory[];
  private readonly platformDefaults: readonly string[];
  private readonly policyOverrides: Readonly<Record<string, CallPolicy>>;

  constructor(
    @Inject(HOTEL_PROVIDER_FACTORIES) factories: HotelProviderFactory[],
    @Inject(HOTEL_PROVIDER_FLAGS) private readonly flags: ProviderFlagsPort,
  ) {
    // Orden ESTABLE, alfabético por code: será parte de la clave de caché de la búsqueda y del
    // orden de `providers[]` en la respuesta.
    this.factories = [...factories].sort((a, b) =>
      a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
    );

    const codes = new Set<string>();
    for (const f of this.factories) {
      if (codes.has(f.code)) throw new Error(`code de proveedor de hoteles duplicado: '${f.code}'`);
      // El tipo ya lo impide; esto cubre el array armado a mano en un `useFactory` con `as`.
      if (f.vertical !== 'hotels') {
        throw new Error(`'${f.code}' no es un proveedor de hoteles`);
      }
      codes.add(f.code);
    }

    this.platformDefaults = parseCodes(
      process.env['PLATFORM_DEFAULT_HOTEL_PROVIDERS'] ?? DEFAULT_PLATFORM_HOTEL_PROVIDERS,
    );
    this.policyOverrides = parsePolicyOverrides(process.env['HOTEL_PROVIDER_CALL_POLICIES'] ?? '');
  }

  /**
   * Proveedores llamables para el tenant, más los habilitados que esta búsqueda no llama, más
   * los que la plataforma conoce pero este tenant no puede usar, cada uno con su motivo.
   */
  async forTenant(tenantId: string): Promise<HotelProviderResolution> {
    const active: ResolvedHotelProvider[] = [];
    const skipped: SkippedProvider[] = [];
    const unavailable: UnavailableProvider[] = [];

    for (const factory of this.factories) {
      const callPolicy = this.policyOf(factory);

      // El flag se consulta ANTES de resolver credenciales: un proveedor 'opt-in' apagado no
      // recibe ninguna llamada, ni al proveedor ni a la bóveda de credenciales.
      if (
        callPolicy === 'opt-in' &&
        !(await this.flags.isEnabledForTenant(tenantId, factory.code))
      ) {
        skipped.push({ code: factory.code, reason: 'opt-in-disabled' });
        continue;
      }

      const resolved = await this.resolve(tenantId, factory, callPolicy);
      if (resolved.ok) active.push(resolved.provider);
      else unavailable.push(resolved.absence);
    }

    return { active, skipped, unavailable };
  }

  /**
   * Un proveedor concreto, para el PreBook (por `offer.provider.name`) y para todo lo que sigue
   * sobre una reserva (por `orders.provider`).
   *
   * NO consulta el flag de `opt-in`: la tarifa ya la emitió ese proveedor, y apagar el flag
   * después no puede dejar una reserva a medio camino sin forma de tocarla.
   */
  async byCode(tenantId: string, code: string): Promise<ResolvedHotelProvider> {
    const factory = this.factories.find((f) => f.code === code);
    if (!factory) throw new ProviderNotAvailableError(code);

    const resolved = await this.resolve(tenantId, factory, this.policyOf(factory));
    if (!resolved.ok) throw new ProviderNotAvailableError(code);
    return resolved.provider;
  }

  /**
   * Un proveedor concreto para una VENTA que no parte de una tarifa que él ya emitió, como el
   * detalle de un hotel pedido por código.
   *
   * A diferencia de {@link byCode}, respeta el flag de `opt-in` igual que la búsqueda, y antes de
   * resolver credenciales: sin esto, nombrar al proveedor en el request era una puerta lateral para
   * consultar, con la cuenta heredada, a un proveedor que la búsqueda de ese tenant nunca llama.
   */
  async byCodeForSale(tenantId: string, code: string): Promise<ResolvedHotelProvider> {
    const factory = this.factories.find((f) => f.code === code);
    if (
      factory !== undefined &&
      this.policyOf(factory) === 'opt-in' &&
      !(await this.flags.isEnabledForTenant(tenantId, factory.code))
    ) {
      throw new ProviderNotAvailableError(code);
    }
    return this.byCode(tenantId, code);
  }

  /** Sólo los codes habilitados, en orden estable. Para la clave de caché. */
  async codesForTenant(tenantId: string): Promise<string[]> {
    const { active } = await this.forTenant(tenantId);
    return active.map((p) => p.code);
  }

  /**
   * Todos los proveedores registrados con su perfil de búsqueda, sin tocar credenciales ni flags.
   *
   * Existe para lo que se decide ANTES de gastar cuota o ir a la bóveda: si ningún proveedor tiene
   * catálogo para el destino, la búsqueda se corta sin resolver la cuenta de nadie.
   */
  registered(): readonly HotelProviderRegistration[] {
    return this.factories.map((f) => ({ code: f.code, searchProfile: f.searchProfile }));
  }

  /**
   * Qué sabe hacer un proveedor, sin tocar credenciales.
   * `undefined` = no es un proveedor de hoteles conocido.
   */
  capabilitiesOf(code: string): HotelProviderCapabilities | undefined {
    return this.factories.find((f) => f.code === code)?.capabilities;
  }

  /** Traductor de errores del proveedor. Sin factory conocido, el mensaje crudo. */
  humanizeError(code: string, err: unknown, context?: ProviderErrorContext): string {
    const factory = this.factories.find((f) => f.code === code);
    if (factory) return factory.humanizeError(err, context);
    return err instanceof Error ? err.message : String(err);
  }

  private policyOf(factory: HotelProviderFactory): CallPolicy {
    return this.policyOverrides[factory.code] ?? factory.defaultCallPolicy;
  }

  /**
   * Resuelve UN proveedor para el tenant, o dice por qué no. La ausencia viaja a la respuesta
   * con su motivo: un `null` obligaría al llamador a adivinarlo.
   */
  private async resolve(
    tenantId: string,
    factory: HotelProviderFactory,
    callPolicy: CallPolicy,
  ): Promise<HotelProviderResolutionOutcome> {
    let resolved;
    try {
      resolved = await factory.resolveForTenant(tenantId);
    } catch (err) {
      // Cuenta cargada pero a medias: la acción del vendedor es COMPLETARLA, no cargarla.
      if (err instanceof ProviderAccountIncompleteError) {
        return {
          ok: false,
          absence: {
            code: factory.code,
            reason: 'incomplete-account',
            detail: `Faltan datos en la cuenta de este proveedor (${err.missingFields.join(', ')}). Completala en Mi Red → Credenciales.`,
          },
        };
      }
      // Hay cuenta, pero la plataforma no opera con ella: la acción la dice el propio factory.
      if (err instanceof ProviderAccountNotAllowedError) {
        return {
          ok: false,
          absence: { code: factory.code, reason: 'no-credentials', detail: err.detail },
        };
      }
      // Sin cuenta resoluble y sin fallback: el proveedor no está habilitado para el tenant.
      // Cualquier otro error (bóveda caída, credencial corrupta) sí se propaga.
      if (err instanceof NotFoundException) return { ok: false, absence: this.sinCuenta(factory) };
      throw err;
    }

    if (resolved.credentialSource === 'env' && !this.platformDefaults.includes(factory.code)) {
      // Sin esta puerta, un tenant sin cuenta saldría igual al proveedor con la de la
      // plataforma: consultas y reservas facturadas a quien no las pidió.
      this.logger.debug(
        `${factory.code} sin credenciales propias y sin fallback de plataforma: no habilitado`,
      );
      return { ok: false, absence: this.sinCuenta(factory) };
    }

    // Precedencia: override de entorno > lo que declare la CUENTA del tenant > default del
    // factory. El override va primero porque es el kill-switch de operaciones.
    return {
      ok: true,
      provider: {
        code: factory.code,
        adapter: resolved.adapter,
        credentialSource: resolved.credentialSource,
        capabilities: factory.capabilities,
        searchProfile: factory.searchProfile,
        callPolicy: this.policyOverrides[factory.code] ?? resolved.callPolicy ?? callPolicy,
        ...(resolved.circuit === undefined ? {} : { circuit: resolved.circuit }),
      },
    };
  }

  private sinCuenta(factory: HotelProviderFactory): UnavailableProvider {
    return {
      code: factory.code,
      reason: 'no-credentials',
      detail:
        'Esta agencia no tiene credenciales propias ni heredadas para este proveedor. Cargalas en Mi Red → Credenciales.',
    };
  }
}
