import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from '@sales-travel/validation';
import {
  CallPolicySchema,
  FLIGHT_PROVIDER_FACTORIES,
  FLIGHT_PROVIDER_FLAGS,
  ProviderAccountIncompleteError,
  ProviderNotAvailableError,
  type CallPolicy,
  type FlightProviderAdapter,
  type FlightProviderResolution,
  type ProviderCapabilities,
  type ProviderFlagsPort,
  type ResolvedProvider,
  type SkippedProvider,
  type TenantProviderFactory,
  type UnavailableProvider,
} from './provider.types.js';

/**
 * Proveedores a los que la plataforma presta SUS credenciales cuando el tenant no tiene ni
 * hereda una cuenta. Es el comportamiento legacy del único proveedor de vuelos que existía;
 * se conserva para él y NO se extiende al resto por defecto.
 */
const DEFAULT_PLATFORM_PROVIDERS = 'latam-ndc';

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
 * `FLIGHT_PROVIDER_CALL_POLICIES=code:always,otro:opt-in`. Se valida con Zod y se parsea al
 * arrancar, no en cada búsqueda: un valor mal escrito tiene que tumbar el despliegue, no
 * convertirse en un proveedor que deja de llamarse sin que nadie lo note.
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

/**
 * Resolución de UN proveedor: o sale llamable, o sale la ausencia con su motivo.
 */
type ProviderResolutionOutcome =
  | { readonly ok: true; readonly provider: ResolvedProvider<FlightProviderAdapter> }
  | { readonly ok: false; readonly absence: UnavailableProvider };

/**
 * Registry de proveedores de vuelos por tenant.
 *
 * Antes, el servicio de búsqueda inyectaba el factory de UN proveedor concreto y lo nombraba
 * en una constante; sumar otro obligaba a reescribir el servicio, las órdenes y la post-venta.
 * Acá se resuelve, por tenant: qué proveedores están habilitados, con qué credenciales, qué
 * saben hacer y cuándo se les puede llamar.
 */
@Injectable()
export class FlightProviderRegistry {
  private readonly logger = new Logger(FlightProviderRegistry.name);
  private readonly factories: readonly TenantProviderFactory<FlightProviderAdapter>[];
  private readonly platformDefaults: readonly string[];
  private readonly policyOverrides: Readonly<Record<string, CallPolicy>>;

  constructor(
    @Inject(FLIGHT_PROVIDER_FACTORIES)
    factories: TenantProviderFactory<FlightProviderAdapter>[],
    @Inject(FLIGHT_PROVIDER_FLAGS) private readonly flags: ProviderFlagsPort,
  ) {
    // Orden ESTABLE, alfabético por code: es parte de la clave de caché y del orden de
    // `providers[]` en la respuesta. Un orden que dependa del orden de inyección produce
    // cache misses y una lista que salta entre búsquedas idénticas.
    this.factories = [...factories].sort((a, b) =>
      a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
    );

    const codes = new Set<string>();
    for (const f of this.factories) {
      if (codes.has(f.code)) throw new Error(`code de proveedor duplicado: '${f.code}'`);
      codes.add(f.code);
    }

    this.platformDefaults = parseCodes(
      process.env['PLATFORM_DEFAULT_FLIGHT_PROVIDERS'] ?? DEFAULT_PLATFORM_PROVIDERS,
    );
    this.policyOverrides = parsePolicyOverrides(process.env['FLIGHT_PROVIDER_CALL_POLICIES'] ?? '');
  }

  /**
   * Proveedores llamables para el tenant, más los habilitados que esta búsqueda no llama, más
   * los que la plataforma conoce pero este tenant no puede usar.
   *
   * `unavailable` es lo que hace explicable una lista corta: un proveedor sin credenciales
   * usables ya no cae a fixtures ni desaparece en silencio — sale nombrado, con el motivo.
   */
  async forTenant(tenantId: string): Promise<FlightProviderResolution> {
    const active: ResolvedProvider<FlightProviderAdapter>[] = [];
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
   * Un proveedor concreto, para revalidar precio y para todo el ciclo de la orden.
   *
   * NO consulta el flag de `opt-in`: la oferta ya la emitió ese proveedor, y apagar el flag
   * después no puede dejar una reserva a medio camino sin forma de tocarla.
   */
  async byCode(tenantId: string, code: string): Promise<ResolvedProvider<FlightProviderAdapter>> {
    const factory = this.factories.find((f) => f.code === code);
    if (!factory) throw new ProviderNotAvailableError(code);

    const resolved = await this.resolve(tenantId, factory, this.policyOf(factory));
    if (!resolved.ok) throw new ProviderNotAvailableError(code);
    return resolved.provider;
  }

  /**
   * Sólo los codes habilitados, en orden estable. Para la clave de caché.
   *
   * Resuelve igual que `forTenant` porque la habilitación depende de las credenciales del
   * tenant; no cuesta una construcción de adapter por llamada: cada factory cachea sus
   * instancias por credenciales.
   */
  async codesForTenant(tenantId: string): Promise<string[]> {
    const { active } = await this.forTenant(tenantId);
    return active.map((p) => p.code);
  }

  /**
   * Qué sabe hacer un proveedor. Es estático por proveedor (no depende del tenant), así que
   * no toca credenciales: sirve para gatear la post-venta antes de resolver nada.
   * `undefined` = no es un proveedor de vuelos conocido.
   */
  capabilitiesOf(code: string): ProviderCapabilities | undefined {
    return this.factories.find((f) => f.code === code)?.capabilities;
  }

  /** Traductor de errores del proveedor. Sin factory conocido, el mensaje crudo. */
  humanizeError(code: string, err: unknown): string {
    const factory = this.factories.find((f) => f.code === code);
    if (factory) return factory.humanizeError(err);
    return err instanceof Error ? err.message : String(err);
  }

  private policyOf(factory: TenantProviderFactory<FlightProviderAdapter>): CallPolicy {
    return this.policyOverrides[factory.code] ?? factory.defaultCallPolicy;
  }

  /**
   * Resuelve UN proveedor para el tenant, o dice por qué no.
   *
   * Devuelve un resultado etiquetado y no `null`: la ausencia viaja a la respuesta del endpoint
   * con su motivo, y un `null` obligaría al llamador a reconstruirlo a posteriori —adivinando—.
   */
  private async resolve(
    tenantId: string,
    factory: TenantProviderFactory<FlightProviderAdapter>,
    callPolicy: CallPolicy,
  ): Promise<ProviderResolutionOutcome> {
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
      // Sin cuenta resoluble y sin fallback: el proveedor no está habilitado para el tenant.
      // Cualquier otro error (bóveda caída, credencial corrupta) sí se propaga.
      if (err instanceof NotFoundException) return { ok: false, absence: this.sinCuenta(factory) };
      throw err;
    }

    if (resolved.credentialSource === 'env' && !this.platformDefaults.includes(factory.code)) {
      // Sin esta puerta, un tenant sin credenciales propias saldría igual al proveedor con la
      // cuenta de la plataforma: consultas facturadas a quien no las pidió y, peor, tarifas de
      // un PCC que no es el suyo.
      this.logger.debug(
        `${factory.code} sin credenciales propias y sin fallback de plataforma: no habilitado`,
      );
      return { ok: false, absence: this.sinCuenta(factory) };
    }

    // Precedencia: override de entorno > lo que declare la CUENTA del tenant > default del
    // factory. El override va primero porque es el kill-switch de operaciones (contener el
    // coste de un proveedor que cobra por consulta), y una cuenta no puede desarmarlo.
    return {
      ok: true,
      provider: {
        code: factory.code,
        adapter: resolved.adapter,
        credentialSource: resolved.credentialSource,
        capabilities: factory.capabilities,
        callPolicy: this.policyOverrides[factory.code] ?? resolved.callPolicy ?? callPolicy,
      },
    };
  }

  private sinCuenta(factory: TenantProviderFactory<FlightProviderAdapter>): UnavailableProvider {
    return {
      code: factory.code,
      reason: 'no-credentials',
      detail:
        'Esta agencia no tiene credenciales propias ni heredadas para este proveedor. Cargalas en Mi Red → Credenciales.',
    };
  }
}
