#!/usr/bin/env node
/**
 * Generates the extended Acme Manufactura batches (04–06) that grow the demo
 * graph to ~150 nodes. All content is synthetic and hand-authored here; the
 * script only assembles deterministic locators (line ranges, doc sections,
 * interview turns) so the emitted JSON is stable run to run.
 *
 * Regenerate with:  node examples/acme-manufactura/tools/generate-extended-batches.mjs
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'batches');

// ---------------------------------------------------------------------------
// Deterministic locator builders
// ---------------------------------------------------------------------------

const COMMIT = 'e5f6a7b';
const lineCounters = new Map();
function codeLocator(repo, path, span = 9) {
  const key = `${repo}:${path}`;
  const start = (lineCounters.get(key) ?? 3) + 2;
  const end = start + span;
  lineCounters.set(key, end);
  return { repo, path, line_start: start, line_end: end, commit: COMMIT };
}

const DOC_TITLES = {
  'manual-compras': 'Manual de compras',
  'manual-logistica': 'Manual de logística',
  'manual-calidad': 'Manual de calidad',
  'plan-mantenimiento': 'Plan de mantenimiento',
  'normativa-rrhh': 'Normativa laboral interna',
  'politica-medioambiental': 'Política medioambiental',
  'manual-comercial': 'Manual comercial',
  'manual-administracion': 'Manual de administración',
};
const sectionCounters = new Map();
function docLocator(docId) {
  const next = (sectionCounters.get(docId) ?? 0) + 1;
  sectionCounters.set(docId, next);
  const chapter = Math.floor((next - 1) / 6) + 1;
  const sub = ((next - 1) % 6) + 1;
  return { doc_id: docId, title: DOC_TITLES[docId], section: `${chapter}.${sub}` };
}

let turn = 2;
function interviewLocator() {
  turn += 2;
  return { interview_id: 'int-002', speaker_role: 'produccion', turn };
}

// ---------------------------------------------------------------------------
// Batch 04 — code (acme-erp, acme-wms, acme-mrp, portal, transporte)
// ---------------------------------------------------------------------------

const codeNodes = [];
const codeEdges = [];

function cn(type, mention, name, description, excerpt, repo, path) {
  codeNodes.push({ mention, type, name, description, evidence: { locator: codeLocator(repo, path), excerpt } });
}
function ce(type, source_mention, target_mention, excerpt, repo, path, extra = {}) {
  codeEdges.push({ type, source_mention, target_mention, ...extra, evidence: { locator: codeLocator(repo, path, 5), excerpt } });
}

// --- compras (acme-erp src/compras, portal-proveedores) --------------------
cn('entity', 'Proveedor', 'Proveedor',
  'Empresa que suministra bobinas de papel, tintas o troqueles a Acme. Tiene estado de homologación y certificados vigentes.',
  "export interface Proveedor { id: string; razonSocial: string; homologado: boolean; certificados: Certificado[]; plazoEntregaDias: number; }",
  'acme-erp', 'src/compras/proveedores.ts');
cn('entity', 'OrdenCompra', 'Orden de compra',
  'Pedido de aprovisionamiento emitido a un proveedor, con líneas de bobina y fecha de entrega solicitada.',
  "export interface OrdenCompra { numero: string; proveedorId: string; lineas: LineaCompra[]; fechaEntrega: Date; estado: EstadoCompra; }",
  'acme-erp', 'src/compras/ordenes-compra.ts');
cn('entity', 'RecepcionMercancia', 'Recepción de mercancía',
  'Registro de entrada de una entrega de proveedor: orden de compra asociada, bultos y resultado del control de entrada.',
  "export interface RecepcionMercancia { id: string; ordenCompra: string; bultos: number; gramajeMedido: number; conforme: boolean; }",
  'acme-erp', 'src/compras/recepciones.ts');
cn('process', 'altaProveedor', 'Alta de proveedor',
  'Registro de un proveedor nuevo con sus datos fiscales, certificados y condiciones de entrega.',
  "export async function altaProveedor(datos: DatosProveedor): Promise<Proveedor> { validarFiscales(datos); return repositorio.crear({ ...datos, homologado: false }); }",
  'acme-erp', 'src/compras/proveedores.ts');
cn('process', 'aprovisionamientoBobinas', 'Aprovisionamiento de bobinas',
  'Emisión de órdenes de compra de bobinas a proveedores homologados a partir de las necesidades del MRP.',
  "export async function aprovisionarBobinas(necesidades: Necesidad[]): Promise<OrdenCompra[]> { const agrupadas = agruparPorProveedor(necesidades); return emitirOrdenes(agrupadas); }",
  'acme-erp', 'src/compras/aprovisionamiento.ts');
cn('process', 'revisionStockMinimo', 'Revisión de stock mínimo',
  'Comprobación nocturna del stock de bobinas contra el mínimo configurado por gramaje.',
  "cron.schedule('0 2 * * *', async () => { const faltantes = await stock.bajoMinimo(); if (faltantes.length) emitir(new StockBajoMinimoEvent(faltantes)); });",
  'acme-mrp', 'src/mrp/revision-stock.ts');
cn('rule', 'bloqueoProveedorNoHomologado', 'Bloqueo de proveedor no homologado',
  'No se puede emitir una orden de compra a un proveedor sin homologación vigente.',
  "if (!proveedor.homologado) { throw new CompraRechazadaError('Proveedor sin homologación vigente: no se admite orden de compra'); }",
  'acme-erp', 'src/compras/ordenes-compra.ts');
cn('rule', 'toleranciaGramajeRecepcion', 'Tolerancia de gramaje en recepción',
  'La bobina recibida se rechaza si su gramaje medido se desvía más de un 4% del solicitado.',
  "const TOLERANCIA_GRAMAJE = 0.04; if (Math.abs(medido - solicitado) / solicitado > TOLERANCIA_GRAMAJE) { recepcion.conforme = false; }",
  'acme-erp', 'src/compras/recepciones.ts');
cn('rule', 'reposicionStockMinimo', 'Reposición por stock mínimo',
  'Cuando el stock de un gramaje baja del mínimo, el MRP calcula la cantidad a reponer hasta el nivel objetivo.',
  "const cantidadAPedir = nivelObjetivo(gramaje) - stockActual(gramaje); if (cantidadAPedir > 0) necesidades.push({ gramaje, cantidadAPedir });",
  'acme-mrp', 'src/mrp/reposicion.ts');
cn('event', 'StockBajoMinimoEvent', 'Stock bajo mínimo',
  'El stock disponible de un gramaje de bobina ha caído por debajo del mínimo configurado.',
  "export class StockBajoMinimoEvent { constructor(readonly faltantes: Necesidad[]) {} }",
  'acme-mrp', 'src/mrp/eventos.ts');
cn('event', 'OrdenCompraEmitidaEvent', 'Orden de compra emitida',
  'Se ha emitido y enviado una orden de compra a un proveedor.',
  "await publicar(new OrdenCompraEmitidaEvent(orden.numero, proveedor.id));",
  'acme-erp', 'src/compras/ordenes-compra.ts');
cn('system', 'portal-proveedores', 'Portal de proveedores',
  'Portal web donde los proveedores confirman órdenes de compra y publican sus certificados.',
  "// portal-proveedores: confirmación de órdenes y gestión documental de certificados",
  'portal-proveedores', 'src/index.ts');
cn('system', 'acme-mrp', 'MRP Acme',
  'Sistema de planificación de necesidades de material: stock mínimo, reposición y necesidades de bobina.',
  "// acme-mrp: planificación de necesidades de material (bobinas por gramaje)",
  'acme-mrp', 'src/index.ts');

ce('VALIDATES', 'bloqueoProveedorNoHomologado', 'altaProveedor',
  "// El alta queda en estado pendiente hasta superar la homologación\nif (!proveedor.homologado) return EstadoAlta.PENDIENTE;",
  'acme-erp', 'src/compras/proveedores.ts');
ce('OPERATES_ON', 'bloqueoProveedorNoHomologado', 'Proveedor',
  "if (!proveedor.homologado) { throw new CompraRechazadaError(...); }",
  'acme-erp', 'src/compras/ordenes-compra.ts');
ce('IMPLEMENTED_IN', 'bloqueoProveedorNoHomologado', 'portal-proveedores',
  "// El portal oculta el botón de confirmar orden a proveedores sin homologación",
  'portal-proveedores', 'src/ordenes/confirmar.ts');
ce('VALIDATES', 'toleranciaGramajeRecepcion', 'recepcionBobinas',
  "if (!dentroDeTolerancia(medido, solicitado)) { recepcion.conforme = false; devolverAlProveedor(recepcion); }",
  'acme-erp', 'src/compras/recepciones.ts');
ce('OPERATES_ON', 'toleranciaGramajeRecepcion', 'Bobina',
  "const medido = medirGramaje(bobina); // gramaje real de la bobina recibida",
  'acme-erp', 'src/compras/recepciones.ts');
ce('IMPLEMENTED_IN', 'toleranciaGramajeRecepcion', 'acme-erp',
  "// Módulo compras del ERP: control de entrada de bobinas",
  'acme-erp', 'src/compras/recepciones.ts');
ce('CALCULATES', 'reposicionStockMinimo', 'StockBobina',
  "const cantidadAPedir = nivelObjetivo(gramaje) - stockActual(gramaje);",
  'acme-mrp', 'src/mrp/reposicion.ts', { attrs: { attribute: 'cantidad_a_pedir' } });
ce('OPERATES_ON', 'reposicionStockMinimo', 'StockBobina',
  "const stockActual = await stock.porGramaje(gramaje);",
  'acme-mrp', 'src/mrp/reposicion.ts');
ce('IMPLEMENTED_IN', 'reposicionStockMinimo', 'acme-mrp',
  "// Reposición automática: forma parte del planificador nocturno del MRP",
  'acme-mrp', 'src/mrp/reposicion.ts');
ce('TRIGGERS', 'revisionStockMinimo', 'StockBajoMinimoEvent',
  "if (faltantes.length) emitir(new StockBajoMinimoEvent(faltantes));",
  'acme-mrp', 'src/mrp/revision-stock.ts');
ce('TRIGGERS', 'StockBajoMinimoEvent', 'aprovisionamientoBobinas',
  "bus.on(StockBajoMinimoEvent, (evento) => aprovisionarBobinas(evento.faltantes));",
  'acme-mrp', 'src/mrp/suscripciones.ts');
ce('EXECUTES', 'acme-mrp', 'revisionStockMinimo',
  "cron.schedule('0 2 * * *', ...) // el MRP ejecuta la revisión sin intervención humana",
  'acme-mrp', 'src/mrp/revision-stock.ts');
ce('TRIGGERS', 'aprovisionamientoBobinas', 'OrdenCompraEmitidaEvent',
  "await publicar(new OrdenCompraEmitidaEvent(orden.numero, proveedor.id));",
  'acme-erp', 'src/compras/aprovisionamiento.ts');
ce('DEPENDS_ON', 'aprovisionamientoBobinas', 'Proveedor',
  "const proveedor = await proveedores.homologadoPara(gramaje); // sin proveedor homologado no hay orden",
  'acme-erp', 'src/compras/aprovisionamiento.ts');
ce('DEPENDS_ON', 'aprovisionamientoBobinas', 'OrdenCompra',
  "return emitirOrdenes(agrupadas); // una orden de compra por proveedor y semana",
  'acme-erp', 'src/compras/aprovisionamiento.ts');
ce('TRIGGERS', 'OrdenCompraEmitidaEvent', 'recepcionBobinas',
  "// La recepción se planifica al confirmar el proveedor la orden emitida",
  'acme-wms', 'src/almacen/recepcion.ts');
ce('DEPENDS_ON', 'altaProveedor', 'portal-proveedores',
  "await portal.invitar(proveedor.id); // el alta termina cuando el proveedor entra al portal",
  'acme-erp', 'src/compras/proveedores.ts');
ce('IMPLEMENTED_IN', 'aprovisionamientoBobinas', 'acme-mrp',
  "// El aprovisionamiento vive en el MRP; el ERP solo registra la orden emitida",
  'acme-mrp', 'src/mrp/aprovisionamiento.ts');

// --- almacén (acme-wms) -----------------------------------------------------
cn('entity', 'UbicacionAlmacen', 'Ubicación de almacén',
  'Hueco físico de almacén identificado por pasillo, módulo y altura donde se deposita una bobina o un palet.',
  "export interface UbicacionAlmacen { codigo: string; pasillo: number; modulo: number; altura: number; ocupada: boolean; }",
  'acme-wms', 'src/almacen/ubicaciones.ts');
cn('entity', 'StockBobina', 'Stock de bobina',
  'Existencias de bobina por gramaje y ancho: cantidad disponible, reservada y fecha de entrada de cada unidad.',
  "export interface StockBobina { gramaje: number; anchoMm: number; disponibles: number; reservadas: number; entradas: EntradaBobina[]; }",
  'acme-wms', 'src/almacen/stock.ts');
cn('entity', 'Palet', 'Palet',
  'Unidad de expedición: agrupación de cajas terminadas flejada y etiquetada para carga.',
  "export interface Palet { id: string; pedidoNumero: string; cajas: number; pesoKg: number; ubicacion?: string; }",
  'acme-wms', 'src/almacen/palets.ts');
cn('process', 'recepcionBobinas', 'Recepción de bobinas',
  'Descarga, control de entrada y ubicación de las bobinas entregadas por un proveedor.',
  "export async function recibirBobinas(entrega: Entrega): Promise<void> { const recepcion = controlDeEntrada(entrega); await ubicar(recepcion.bobinas); emitir(new BobinaRecibidaEvent(recepcion)); }",
  'acme-wms', 'src/almacen/recepcion.ts');
cn('process', 'inventarioCiclico', 'Inventario cíclico',
  'Recuento rotativo semanal de un subconjunto de ubicaciones para cuadrar stock físico y stock del sistema.',
  "export async function inventarioCiclico(semana: number): Promise<Recuento[]> { const ubicaciones = plan.ubicacionesPara(semana); return contar(ubicaciones); }",
  'acme-wms', 'src/almacen/inventario.ts');
cn('rule', 'fifoBobinas', 'FIFO de bobinas por antigüedad',
  'Al asignar bobina a una tirada se consume siempre la de entrada más antigua del gramaje requerido.',
  "const candidatas = stock.porGramaje(gramaje).sort((a, b) => a.fechaEntrada - b.fechaEntrada); return candidatas[0]; // FIFO estricto",
  'acme-wms', 'src/almacen/stock.ts');
cn('event', 'BobinaRecibidaEvent', 'Bobina recibida',
  'Una bobina ha superado el control de entrada y ha quedado ubicada en el almacén.',
  "export class BobinaRecibidaEvent { constructor(readonly recepcion: RecepcionMercancia) {} }",
  'acme-wms', 'src/almacen/eventos.ts');
cn('system', 'acme-wms', 'SGA de almacén',
  'Sistema de gestión de almacén: ubicaciones, stock de bobinas, picking y cargas.',
  "// acme-wms: sistema de gestión de almacén (SGA) de la planta de Acme",
  'acme-wms', 'src/index.ts');

ce('TRIGGERS', 'recepcionBobinas', 'BobinaRecibidaEvent',
  "emitir(new BobinaRecibidaEvent(recepcion));",
  'acme-wms', 'src/almacen/recepcion.ts');
ce('DEPENDS_ON', 'recepcionBobinas', 'RecepcionMercancia',
  "const recepcion = controlDeEntrada(entrega); // registra la recepción de mercancía en el ERP",
  'acme-wms', 'src/almacen/recepcion.ts');
ce('IMPLEMENTED_IN', 'recepcionBobinas', 'acme-wms',
  "// Descarga y ubicación gestionadas íntegramente por el SGA",
  'acme-wms', 'src/almacen/recepcion.ts');
ce('VALIDATES', 'fifoBobinas', 'procesoTroquelado',
  "// La tirada no arranca si la bobina montada no es la más antigua del gramaje\nif (!esLaMasAntigua(bobina)) throw new FifoVioladoError();",
  'acme-wms', 'src/almacen/stock.ts');
ce('OPERATES_ON', 'fifoBobinas', 'Bobina',
  "const candidatas = stock.porGramaje(gramaje).sort((a, b) => a.fechaEntrada - b.fechaEntrada);",
  'acme-wms', 'src/almacen/stock.ts');
ce('IMPLEMENTED_IN', 'fifoBobinas', 'acme-wms',
  "// El SGA propone la bobina y bloquea la confirmación si no se respeta el orden",
  'acme-wms', 'src/almacen/stock.ts');
ce('DEPENDS_ON', 'inventarioCiclico', 'UbicacionAlmacen',
  "const ubicaciones = plan.ubicacionesPara(semana);",
  'acme-wms', 'src/almacen/inventario.ts');
ce('DEPENDS_ON', 'inventarioCiclico', 'StockBobina',
  "const diferencia = recuento.fisico - stock.disponibles; // ajuste contra stock del sistema",
  'acme-wms', 'src/almacen/inventario.ts');
ce('IMPLEMENTED_IN', 'inventarioCiclico', 'acme-wms',
  "// Plan de recuento rotativo configurado en el SGA",
  'acme-wms', 'src/almacen/inventario.ts');

// --- logística (acme-erp src/logistica + plataforma-transporte) ------------
cn('entity', 'Albaran', 'Albarán',
  'Documento de entrega que acompaña a la mercancía expedida y que el cliente firma en destino.',
  "export interface Albaran { numero: string; pedidoNumero: string; palets: string[]; fechaEntrega?: Date; firmado: boolean; }",
  'acme-erp', 'src/logistica/albaranes.ts');
cn('entity', 'Transportista', 'Transportista',
  'Empresa de transporte contratada para las rutas de reparto, con tarifa por kilómetro y capacidad por vehículo.',
  "export interface Transportista { id: string; nombre: string; tarifaKm: number; capacidadKg: number; }",
  'acme-erp', 'src/logistica/transportistas.ts');
cn('entity', 'RutaReparto', 'Ruta de reparto',
  'Secuencia de entregas asignada a un camión para un día: paradas, kilómetros y carga total.',
  "export interface RutaReparto { id: string; fecha: Date; transportistaId: string; paradas: Parada[]; cargaKg: number; }",
  'acme-erp', 'src/logistica/rutas.ts');
cn('process', 'pickingExpedicion', 'Picking de expedición',
  'Preparación de los palets de un pedido: localización en almacén, flejado y etiquetado para carga.',
  "export async function pickingExpedicion(pedido: Pedido): Promise<Palet[]> { const palets = await localizarYFlejar(pedido); etiquetar(palets); return palets; }",
  'acme-wms', 'src/expedicion/picking.ts');
cn('process', 'planificacionRutas', 'Planificación de rutas de reparto',
  'Asignación diaria de entregas pendientes a rutas y transportistas minimizando kilómetros.',
  "export async function planificarRutas(fecha: Date): Promise<RutaReparto[]> { const entregas = await pendientes(fecha); return optimizador.asignar(entregas); }",
  'acme-erp', 'src/logistica/rutas.ts');
cn('process', 'cargaCamion', 'Carga de camión',
  'Carga física de los palets de una ruta en el camión asignado, con verificación de peso y destino.',
  "export async function cargarCamion(ruta: RutaReparto): Promise<void> { for (const palet of paletsDe(ruta)) verificarYSubir(palet); emitir(new CamionCargadoEvent(ruta.id)); }",
  'acme-wms', 'src/expedicion/carga.ts');
cn('rule', 'cargaMaximaCamion', 'Carga máxima por camión',
  'La carga asignada a una ruta no puede superar la capacidad del vehículo del transportista (por defecto 24.000 kg).',
  "if (ruta.cargaKg > transportista.capacidadKg) { throw new RutaInvalidaError('Carga superior a la capacidad del vehículo'); }",
  'plataforma-transporte', 'src/rutas/validaciones.ts');
cn('rule', 'agrupacionEntregasCP', 'Agrupación de entregas por código postal',
  'Las entregas del día se agrupan en rutas por prefijo de código postal para minimizar kilómetros.',
  "const grupos = agruparPor(entregas, (e) => e.codigoPostal.slice(0, 2)); return grupos.map(aRuta);",
  'plataforma-transporte', 'src/rutas/optimizador.ts');
cn('rule', 'prioridadPickingUrgentes', 'Prioridad de picking para urgentes',
  'Los pedidos marcados como urgentes se preparan antes que el resto en la cola de picking.',
  "cola.sort((a, b) => Number(b.pedido.urgente) - Number(a.pedido.urgente)); // urgentes primero, siempre",
  'acme-wms', 'src/expedicion/picking.ts');
cn('event', 'CamionCargadoEvent', 'Camión cargado',
  'Todos los palets de una ruta han sido verificados y cargados en el camión.',
  "export class CamionCargadoEvent { constructor(readonly rutaId: string) {} }",
  'acme-wms', 'src/expedicion/eventos.ts');
cn('system', 'plataforma-transporte', 'Plataforma de transporte',
  'Integración con transportistas: optimización de rutas, validación de cargas y seguimiento de entregas.',
  "// plataforma-transporte: optimizador de rutas e integración con transportistas",
  'plataforma-transporte', 'src/index.ts');

ce('PART_OF', 'pickingExpedicion', 'expedicion',
  "// El picking es la primera fase del proceso de expedición",
  'acme-wms', 'src/expedicion/picking.ts');
ce('PART_OF', 'cargaCamion', 'expedicion',
  "// La carga cierra la expedición: tras el evento CamionCargado se emite el albarán",
  'acme-wms', 'src/expedicion/carga.ts');
ce('DEPENDS_ON', 'pickingExpedicion', 'Palet',
  "const palets = await localizarYFlejar(pedido);",
  'acme-wms', 'src/expedicion/picking.ts');
ce('DEPENDS_ON', 'cargaCamion', 'Albaran',
  "const albaran = await albaranes.emitirPara(ruta); // sin albarán no sale el camión",
  'acme-wms', 'src/expedicion/carga.ts');
ce('VALIDATES', 'prioridadPickingUrgentes', 'pickingExpedicion',
  "cola.sort((a, b) => Number(b.pedido.urgente) - Number(a.pedido.urgente));",
  'acme-wms', 'src/expedicion/picking.ts');
ce('OPERATES_ON', 'prioridadPickingUrgentes', 'Pedido',
  "// La prioridad se decide por el indicador urgente del pedido",
  'acme-wms', 'src/expedicion/picking.ts');
ce('IMPLEMENTED_IN', 'prioridadPickingUrgentes', 'acme-wms',
  "// Orden de la cola de picking gestionado por el SGA",
  'acme-wms', 'src/expedicion/picking.ts');
ce('VALIDATES', 'cargaMaximaCamion', 'cargaCamion',
  "if (ruta.cargaKg > transportista.capacidadKg) throw new RutaInvalidaError(...);",
  'plataforma-transporte', 'src/rutas/validaciones.ts');
ce('OPERATES_ON', 'cargaMaximaCamion', 'RutaReparto',
  "const cargaKg = ruta.paradas.reduce((kg, p) => kg + p.pesoKg, 0);",
  'plataforma-transporte', 'src/rutas/validaciones.ts');
ce('IMPLEMENTED_IN', 'cargaMaximaCamion', 'plataforma-transporte',
  "// Validación de capacidad en la plataforma antes de confirmar la ruta",
  'plataforma-transporte', 'src/rutas/validaciones.ts');
ce('CALCULATES', 'agrupacionEntregasCP', 'RutaReparto',
  "const grupos = agruparPor(entregas, (e) => e.codigoPostal.slice(0, 2));",
  'plataforma-transporte', 'src/rutas/optimizador.ts', { attrs: { attribute: 'paradas' } });
ce('IMPLEMENTED_IN', 'agrupacionEntregasCP', 'plataforma-transporte',
  "// Agrupación por prefijo postal dentro del optimizador de rutas",
  'plataforma-transporte', 'src/rutas/optimizador.ts');
ce('TRIGGERS', 'cargaCamion', 'CamionCargadoEvent',
  "emitir(new CamionCargadoEvent(ruta.id));",
  'acme-wms', 'src/expedicion/carga.ts');
ce('DEPENDS_ON', 'planificacionRutas', 'Transportista',
  "const disponibles = await transportistas.conCapacidad(fecha);",
  'acme-erp', 'src/logistica/rutas.ts');
ce('DEPENDS_ON', 'planificacionRutas', 'RutaReparto',
  "return optimizador.asignar(entregas); // materializa las rutas del día",
  'acme-erp', 'src/logistica/rutas.ts');
ce('IMPLEMENTED_IN', 'planificacionRutas', 'plataforma-transporte',
  "// La asignación de rutas delega en el optimizador de la plataforma",
  'acme-erp', 'src/logistica/rutas.ts');
ce('TRIGGERS', 'planificacionRutas', 'pickingExpedicion',
  "for (const ruta of rutas) await colaPicking.encolar(ruta.paradas); // el picking se lanza al cerrar la planificación",
  'acme-erp', 'src/logistica/rutas.ts');

// --- comercial: tarifas, presupuestos y troqueles (acme-erp) ----------------
cn('entity', 'Tarifa', 'Tarifa',
  'Lista de precios vigente por tipo de caja, calidad de cartón y tramo de cantidad.',
  "export interface Tarifa { id: string; vigenciaDesde: Date; precios: PrecioPorM2[]; costePapelReferencia: number; }",
  'acme-erp', 'src/comercial/tarifas.ts');
cn('entity', 'Presupuesto', 'Presupuesto',
  'Oferta económica emitida a un cliente para un trabajo de embalaje, con validez limitada.',
  "export interface Presupuesto { numero: string; clienteId: string; lineas: LineaPresupuesto[]; validoHasta: Date; aceptado: boolean; }",
  'acme-erp', 'src/comercial/presupuestos.ts');
cn('entity', 'Troquel', 'Troquel',
  'Herramienta física de corte propiedad del cliente o de Acme, con coste de fabricación amortizable.',
  "export interface Troquel { id: string; clienteId?: string; costeFabricacion: number; usosAcumulados: number; ubicacion: string; }",
  'acme-erp', 'src/produccion/troqueles.ts');
cn('process', 'elaboracionPresupuestos', 'Elaboración de presupuestos',
  'Confección de la oferta económica: cálculo de material, amortización de troquel y margen comercial.',
  "export function elaborarPresupuesto(solicitud: Solicitud): Presupuesto { const material = costeMaterial(solicitud); const troquel = amortizacionTroquel(solicitud); return componer(material, troquel); }",
  'acme-erp', 'src/comercial/presupuestos.ts');
cn('process', 'altaTroquel', 'Alta de troquel',
  'Registro de un troquel nuevo con su plano, coste de fabricación y ubicación física en el almacén de troqueles.',
  "export async function altaTroquel(plano: Plano, coste: number): Promise<Troquel> { return troqueles.crear({ plano, costeFabricacion: coste, usosAcumulados: 0 }); }",
  'acme-erp', 'src/produccion/troqueles.ts');
cn('rule', 'descuentoMaximoComercial', 'Descuento máximo del comercial',
  'Un comercial no puede aplicar más de un 5% de descuento sobre tarifa sin aprobación de gerencia.',
  "const DESCUENTO_MAX_COMERCIAL = 0.05; if (descuento > DESCUENTO_MAX_COMERCIAL && !aprobadoPorGerencia) { throw new DescuentoNoAutorizadoError(); }",
  'acme-erp', 'src/comercial/presupuestos.ts');
cn('rule', 'precioMinimoM2', 'Precio mínimo por metro cuadrado',
  'Ninguna línea de presupuesto puede quedar por debajo del precio mínimo por metro cuadrado de cartón.',
  "const PRECIO_MINIMO_M2 = 0.42; if (linea.precioM2 < PRECIO_MINIMO_M2) { throw new PrecioBajoMinimoError(linea); }",
  'acme-erp', 'src/comercial/tarifas.ts');
cn('rule', 'validezPresupuesto', 'Validez de presupuesto',
  'Un presupuesto caduca a los 30 días naturales de su emisión y no puede aceptarse después.',
  "const VALIDEZ_DIAS = 30; if (hoy > presupuesto.validoHasta) { throw new PresupuestoCaducadoError(presupuesto.numero); }",
  'acme-erp', 'src/comercial/presupuestos.ts');
cn('rule', 'amortizacionTroquel', 'Amortización de troquel en presupuesto',
  'El coste de fabricación de un troquel nuevo se reparte entre las tres primeras tiradas presupuestadas.',
  "const AMORTIZACION_TIRADAS = 3; const costePorTirada = troquel.costeFabricacion / AMORTIZACION_TIRADAS; presupuesto.costeTroquel = costePorTirada;",
  'acme-erp', 'src/comercial/presupuestos.ts');
cn('event', 'PresupuestoAceptadoEvent', 'Presupuesto aceptado',
  'El cliente ha aceptado un presupuesto dentro de su plazo de validez.',
  "export class PresupuestoAceptadoEvent { constructor(readonly numero: string) {} }",
  'acme-erp', 'src/comercial/eventos.ts');

ce('CALCULATES', 'precioMinimoM2', 'Presupuesto',
  "if (linea.precioM2 < PRECIO_MINIMO_M2) throw new PrecioBajoMinimoError(linea);",
  'acme-erp', 'src/comercial/tarifas.ts', { attrs: { attribute: 'precio_m2' } });
ce('OPERATES_ON', 'precioMinimoM2', 'Tarifa',
  "const minimo = tarifa.precios.find((p) => p.calidad === linea.calidad).minimoM2;",
  'acme-erp', 'src/comercial/tarifas.ts');
ce('IMPLEMENTED_IN', 'precioMinimoM2', 'acme-erp',
  "// Suelo de precio aplicado por el módulo comercial del ERP",
  'acme-erp', 'src/comercial/tarifas.ts');
ce('VALIDATES', 'descuentoMaximoComercial', 'Presupuesto',
  "if (descuento > DESCUENTO_MAX_COMERCIAL && !aprobadoPorGerencia) throw new DescuentoNoAutorizadoError();",
  'acme-erp', 'src/comercial/presupuestos.ts');
ce('OPERATES_ON', 'descuentoMaximoComercial', 'Presupuesto',
  "const descuento = 1 - presupuesto.importe / importeTarifa(presupuesto);",
  'acme-erp', 'src/comercial/presupuestos.ts');
ce('IMPLEMENTED_IN', 'descuentoMaximoComercial', 'web-pedidos',
  "// La web limita el campo de descuento del comercial al máximo autorizado",
  'web-pedidos', 'src/presupuestos/form.ts');
ce('VALIDATES', 'validezPresupuesto', 'Presupuesto',
  "if (hoy > presupuesto.validoHasta) throw new PresupuestoCaducadoError(presupuesto.numero);",
  'acme-erp', 'src/comercial/presupuestos.ts');
ce('IMPLEMENTED_IN', 'validezPresupuesto', 'acme-erp',
  "// Caducidad comprobada al aceptar el presupuesto",
  'acme-erp', 'src/comercial/presupuestos.ts');
ce('CALCULATES', 'amortizacionTroquel', 'Presupuesto',
  "presupuesto.costeTroquel = troquel.costeFabricacion / AMORTIZACION_TIRADAS;",
  'acme-erp', 'src/comercial/presupuestos.ts', { attrs: { attribute: 'coste_troquel' } });
ce('OPERATES_ON', 'amortizacionTroquel', 'Troquel',
  "if (troquel.usosAcumulados >= AMORTIZACION_TIRADAS) presupuesto.costeTroquel = 0;",
  'acme-erp', 'src/comercial/presupuestos.ts');
ce('IMPLEMENTED_IN', 'amortizacionTroquel', 'acme-erp',
  "// Amortización calculada al componer el presupuesto",
  'acme-erp', 'src/comercial/presupuestos.ts');
ce('DEPENDS_ON', 'elaboracionPresupuestos', 'Tarifa',
  "const material = costeMaterial(solicitud, tarifaVigente());",
  'acme-erp', 'src/comercial/presupuestos.ts');
ce('DEPENDS_ON', 'elaboracionPresupuestos', 'amortizacionTroquel',
  "const troquel = amortizacionTroquel(solicitud); // regla de reparto del coste del troquel",
  'acme-erp', 'src/comercial/presupuestos.ts');
ce('IMPLEMENTED_IN', 'elaboracionPresupuestos', 'acme-erp',
  "// Módulo comercial del ERP: presupuestos",
  'acme-erp', 'src/comercial/presupuestos.ts');
ce('TRIGGERS', 'PresupuestoAceptadoEvent', 'altaPedido',
  "bus.on(PresupuestoAceptadoEvent, (evento) => altaPedidoDesdePresupuesto(evento.numero));",
  'acme-erp', 'src/comercial/suscripciones.ts');
ce('DEPENDS_ON', 'altaTroquel', 'Troquel',
  "return troqueles.crear({ plano, costeFabricacion: coste, usosAcumulados: 0 });",
  'acme-erp', 'src/produccion/troqueles.ts');
ce('IMPLEMENTED_IN', 'altaTroquel', 'acme-erp',
  "// Registro de troqueles en el módulo de producción del ERP",
  'acme-erp', 'src/produccion/troqueles.ts');
ce('DEPENDS_ON', 'procesoTroquelado', 'Troquel',
  "const troquel = await troqueles.localizar(orden.troquelId); // sin troquel en máquina no hay tirada",
  'acme-erp', 'src/produccion/troqueles.ts');

// --- producción: tiradas (acme-erp) -----------------------------------------
cn('rule', 'bloqueoTiradaSinOF', 'Bloqueo de tirada sin orden de fabricación',
  'La troqueladora no admite iniciar una tirada que no tenga orden de fabricación aprobada.',
  "if (!orden || orden.estado !== 'aprobada') { throw new TiradaSinOrdenError('No se inicia tirada sin orden de fabricación aprobada'); }",
  'acme-erp', 'src/produccion/tiradas.ts');
cn('event', 'TiradaCompletadaEvent', 'Tirada completada',
  'Una tirada de troquelado ha terminado con su recuento de cajas buenas y mermas.',
  "export class TiradaCompletadaEvent { constructor(readonly ordenNumero: string, readonly cajasBuenas: number) {} }",
  'acme-erp', 'src/produccion/tiradas.ts');

ce('VALIDATES', 'bloqueoTiradaSinOF', 'procesoTroquelado',
  "if (!orden || orden.estado !== 'aprobada') throw new TiradaSinOrdenError(...);",
  'acme-erp', 'src/produccion/tiradas.ts');
ce('OPERATES_ON', 'bloqueoTiradaSinOF', 'OrdenFabricacion',
  "const orden = await ordenes.porNumero(tirada.ordenNumero);",
  'acme-erp', 'src/produccion/tiradas.ts');
ce('IMPLEMENTED_IN', 'bloqueoTiradaSinOF', 'acme-erp',
  "// Comprobación previa al arranque de tirada en el módulo de producción",
  'acme-erp', 'src/produccion/tiradas.ts');
ce('TRIGGERS', 'procesoTroquelado', 'TiradaCompletadaEvent',
  "emitir(new TiradaCompletadaEvent(orden.numero, recuento.buenas));",
  'acme-erp', 'src/produccion/tiradas.ts');
ce('TRIGGERS', 'TiradaCompletadaEvent', 'pickingExpedicion',
  "bus.on(TiradaCompletadaEvent, (evento) => colaPicking.encolarSiCompleto(evento.ordenNumero));",
  'acme-wms', 'src/expedicion/picking.ts');

// --- finanzas (acme-erp src/finanzas + software contable) -------------------
cn('entity', 'LimiteCredito', 'Límite de crédito',
  'Riesgo máximo aceptado por cliente: importe pendiente de cobro que no puede superarse con pedidos nuevos.',
  "export interface LimiteCredito { clienteId: string; importeMaximo: number; riesgoActual: number; revisadoEn: Date; }",
  'acme-erp', 'src/finanzas/credito.ts');
cn('entity', 'Abono', 'Abono',
  'Factura rectificativa emitida a favor del cliente por devoluciones o errores de facturación.',
  "export interface Abono { numero: string; facturaOrigen: string; importe: number; motivo: MotivoAbono; }",
  'acme-erp', 'src/finanzas/abonos.ts');
cn('process', 'controlLimiteCredito', 'Control de límite de crédito',
  'Recálculo del riesgo vivo por cliente con cada factura emitida o cobrada.',
  "export async function recalcularRiesgo(clienteId: string): Promise<void> { const riesgo = await pendienteDeCobro(clienteId); await limites.actualizar(clienteId, riesgo); }",
  'acme-erp', 'src/finanzas/credito.ts');
cn('process', 'reclamacionImpagos', 'Reclamación de impagos',
  'Ciclo de avisos y llamadas al cliente por facturas vencidas hasta el cobro o el paso a incidencia jurídica.',
  "export async function reclamarImpago(factura: Factura): Promise<void> { const aviso = siguienteAviso(factura); await enviar(aviso); }",
  'acme-erp', 'src/finanzas/impagos.ts');
cn('process', 'cierreContableMensual', 'Cierre contable mensual',
  'Conciliación de facturas, abonos y cobros del mes y traspaso al software contable.',
  "export async function cierreContable(mes: string): Promise<Cierre> { conciliar(facturasDe(mes), abonosDe(mes)); return traspasarAContabilidad(mes); }",
  'acme-erp', 'src/finanzas/cierre.ts');
cn('process', 'emisionAbonos', 'Emisión de abonos',
  'Emisión de facturas rectificativas por devoluciones aceptadas o errores de facturación detectados.',
  "export async function emitirAbono(factura: Factura, motivo: MotivoAbono, importe: number): Promise<Abono> { return abonos.emitir({ facturaOrigen: factura.numero, importe, motivo }); }",
  'acme-erp', 'src/finanzas/abonos.ts');
cn('rule', 'bloqueoLimiteCredito', 'Bloqueo por límite de crédito excedido',
  'No se admite un pedido nuevo si el riesgo vivo del cliente más el importe del pedido supera su límite de crédito.',
  "if (limite.riesgoActual + pedido.importeTotal > limite.importeMaximo) { throw new CreditoExcedidoError(cliente.id); }",
  'acme-erp', 'src/finanzas/credito.ts');
cn('rule', 'recargoInteresDemora', 'Recargo por interés de demora',
  'Las facturas cobradas después del vencimiento devengan un interés de demora mensual del 1%.',
  "const INTERES_DEMORA_MENSUAL = 0.01; const recargo = factura.baseImponible * INTERES_DEMORA_MENSUAL * mesesDeRetraso;",
  'acme-conta', 'src/facturas/demora.ts');
cn('rule', 'escaladoReclamacion', 'Escalado de reclamación de impago',
  'Tras tres avisos sin cobro, la factura vencida pasa de administración a incidencia jurídica.',
  "const MAX_AVISOS = 3; if (factura.avisosEnviados >= MAX_AVISOS) { escalarAJuridico(factura); }",
  'acme-conta', 'src/facturas/escalado.ts');
cn('event', 'FacturaVencidaEvent', 'Factura vencida',
  'Una factura ha superado su fecha de vencimiento sin cobro registrado.',
  "export class FacturaVencidaEvent { constructor(readonly numero: string, readonly diasVencida: number) {} }",
  'acme-conta', 'src/facturas/eventos.ts');
cn('event', 'UmbralCreditoEvent', 'Umbral de crédito alcanzado',
  'El riesgo vivo de un cliente ha alcanzado el 90% de su límite de crédito.',
  "if (riesgo >= limite.importeMaximo * 0.9) emitir(new UmbralCreditoEvent(clienteId));",
  'acme-erp', 'src/finanzas/credito.ts');
cn('system', 'acme-conta', 'Software contable',
  'Aplicación de contabilidad donde se asientan facturas, abonos, cobros e intereses de demora.',
  "// acme-conta: contabilidad financiera (asientos, vencimientos, demora)",
  'acme-conta', 'src/index.ts');

ce('VALIDATES', 'bloqueoLimiteCredito', 'altaPedido',
  "// El alta rechaza el pedido cuando el riesgo proyectado supera el límite\nif (excedeLimite(cliente, pedido)) throw new CreditoExcedidoError(cliente.id);",
  'acme-erp', 'src/finanzas/credito.ts');
ce('OPERATES_ON', 'bloqueoLimiteCredito', 'LimiteCredito',
  "if (limite.riesgoActual + pedido.importeTotal > limite.importeMaximo) ...",
  'acme-erp', 'src/finanzas/credito.ts');
ce('IMPLEMENTED_IN', 'bloqueoLimiteCredito', 'web-pedidos',
  "// La web consulta el riesgo vivo antes de confirmar el pedido",
  'web-pedidos', 'src/checkout/credito.ts');
ce('DEPENDS_ON', 'bloqueoLimiteCredito', 'controlLimiteCredito',
  "const limite = await limites.de(cliente.id); // recalculado por el control de riesgo",
  'acme-erp', 'src/finanzas/credito.ts');
ce('CALCULATES', 'recargoInteresDemora', 'Factura',
  "const recargo = factura.baseImponible * INTERES_DEMORA_MENSUAL * mesesDeRetraso;",
  'acme-conta', 'src/facturas/demora.ts', { attrs: { attribute: 'interes_demora' } });
ce('IMPLEMENTED_IN', 'recargoInteresDemora', 'acme-conta',
  "// El interés se asienta como recargo en la contabilidad",
  'acme-conta', 'src/facturas/demora.ts');
ce('TRIGGERS', 'FacturaVencidaEvent', 'reclamacionImpagos',
  "bus.on(FacturaVencidaEvent, (evento) => reclamarImpago(facturas.porNumero(evento.numero)));",
  'acme-erp', 'src/finanzas/impagos.ts');
ce('VALIDATES', 'escaladoReclamacion', 'reclamacionImpagos',
  "if (factura.avisosEnviados >= MAX_AVISOS) escalarAJuridico(factura);",
  'acme-conta', 'src/facturas/escalado.ts');
ce('OPERATES_ON', 'escaladoReclamacion', 'Factura',
  "const vencidas = await facturas.vencidasConAvisos();",
  'acme-conta', 'src/facturas/escalado.ts');
ce('IMPLEMENTED_IN', 'escaladoReclamacion', 'acme-conta',
  "// El escalado vive en el software contable, que conoce los avisos enviados",
  'acme-conta', 'src/facturas/escalado.ts');
ce('TRIGGERS', 'UmbralCreditoEvent', 'controlLimiteCredito',
  "bus.on(UmbralCreditoEvent, (evento) => revisarLimite(evento.clienteId));",
  'acme-erp', 'src/finanzas/credito.ts');
ce('DEPENDS_ON', 'controlLimiteCredito', 'LimiteCredito',
  "await limites.actualizar(clienteId, riesgo);",
  'acme-erp', 'src/finanzas/credito.ts');
ce('IMPLEMENTED_IN', 'controlLimiteCredito', 'acme-erp',
  "// Recalculo de riesgo en el módulo de finanzas del ERP",
  'acme-erp', 'src/finanzas/credito.ts');
ce('DEPENDS_ON', 'reclamacionImpagos', 'Factura',
  "const aviso = siguienteAviso(factura); // la reclamación se articula factura a factura",
  'acme-erp', 'src/finanzas/impagos.ts');
ce('IMPLEMENTED_IN', 'reclamacionImpagos', 'acme-conta',
  "// Los avisos y su histórico se registran en contabilidad",
  'acme-conta', 'src/facturas/avisos.ts');
ce('TRIGGERS', 'Impago de factura', 'reclamacionImpagos',
  "bus.on(FacturaVencidaEvent, ...) // el impago arranca el ciclo de reclamación",
  'acme-erp', 'src/finanzas/impagos.ts');
ce('DEPENDS_ON', 'cierreContableMensual', 'facturacionMensual',
  "conciliar(facturasDe(mes), abonosDe(mes)); // requiere la facturación del mes cerrada",
  'acme-erp', 'src/finanzas/cierre.ts');
ce('DEPENDS_ON', 'cierreContableMensual', 'Abono',
  "const abonos = abonosDe(mes); // los abonos entran en la conciliación",
  'acme-erp', 'src/finanzas/cierre.ts');
ce('IMPLEMENTED_IN', 'cierreContableMensual', 'acme-conta',
  "return traspasarAContabilidad(mes);",
  'acme-erp', 'src/finanzas/cierre.ts');
ce('DEPENDS_ON', 'emisionAbonos', 'Factura',
  "return abonos.emitir({ facturaOrigen: factura.numero, importe, motivo });",
  'acme-erp', 'src/finanzas/abonos.ts');
ce('IMPLEMENTED_IN', 'emisionAbonos', 'acme-conta',
  "// El abono genera su asiento rectificativo en contabilidad",
  'acme-conta', 'src/facturas/abonos.ts');

// --- re-mentions of existing nodes referenced by the edges above ------------
cn('entity', 'Bobina', 'Bobina',
  'Bobina de papel (materia prima del cartón) con gramaje, ancho y fecha de entrada en almacén.',
  "entrada.fechaEntrada = new Date(); // cada bobina conserva su fecha de entrada para el FIFO",
  'acme-wms', 'src/almacen/stock.ts');
cn('entity', 'Pedido', 'Pedido',
  'Pedido de venta de cajas o planchas de cartón, con indicador de urgencia.',
  "if (pedido.urgente) cola.priorizar(pedido.numero);",
  'acme-wms', 'src/expedicion/picking.ts');
cn('entity', 'Factura', 'Factura',
  'Factura mensual emitida al cliente; su vencimiento gobierna la reclamación de impagos.',
  "if (factura.vencimiento < hoy && !factura.cobrada) emitir(new FacturaVencidaEvent(factura.numero, dias));",
  'acme-conta', 'src/facturas/vencimientos.ts');
cn('entity', 'OrdenFabricacion', 'Orden de fabricación',
  'Orden interna aprobada que autoriza una tirada de troquelado.',
  "const orden = await ordenes.porNumero(tirada.ordenNumero); // debe estar aprobada",
  'acme-erp', 'src/produccion/tiradas.ts');
cn('process', 'altaPedido', 'Alta de pedido',
  'Registro de un pedido de venta; consulta el riesgo de crédito antes de confirmar.',
  "await comprobarCredito(cliente, pedido); // nuevo paso del alta: riesgo de crédito",
  'acme-erp', 'src/finanzas/credito.ts');
cn('process', 'procesoTroquelado', 'Troquelado',
  'Tirada de corte de planchas con troquel montado en máquina.',
  "const tirada = iniciarTirada(orden, troquel, bobina);",
  'acme-erp', 'src/produccion/tiradas.ts');
cn('process', 'expedicion', 'Expedición',
  'Preparación y salida de la mercancía de un pedido: picking, carga y albarán.',
  "// Expedición = picking + carga + emisión de albarán",
  'acme-wms', 'src/expedicion/index.ts');
cn('process', 'facturacionMensual', 'Facturación mensual',
  'Emisión de facturas a fin de mes; su cierre alimenta el cierre contable.',
  "const facturas = facturasDe(mes); // entrada del cierre contable",
  'acme-erp', 'src/finanzas/cierre.ts');
cn('system', 'acme-erp', 'ERP Acme',
  'ERP interno: ventas, compras, producción, logística y finanzas.',
  "// acme-erp: módulos de compras, logística y finanzas añadidos en 2025",
  'acme-erp', 'src/index.ts');
cn('system', 'web-pedidos', 'Web de pedidos',
  'Web de autoservicio donde los clientes registran pedidos; aplica las validaciones de riesgo.',
  "await api.credito.comprobar(cliente.id, importeTotal); // llamada previa a confirmar",
  'web-pedidos', 'src/checkout/credito.ts');
cn('event', 'Impago de factura', 'Impago de factura',
  'Vencimiento de una factura sin pago registrado.',
  "emitir(new FacturaVencidaEvent(factura.numero, dias)); // impago detectado por el barrido diario",
  'acme-conta', 'src/facturas/vencimientos.ts');

const batch04 = {
  run_id: '2026-07-10T09-00-00-code-extended',
  source_type: 'code',
  schema_version: 1,
  extractor: { name: 'extractor-code', model: 'claude-fable-5', prompt_version: 'v1' },
  nodes: codeNodes,
  edges: codeEdges,
};

// ---------------------------------------------------------------------------
// Batch 05 — documents (6 new manuals + additions to the original ones)
// ---------------------------------------------------------------------------

const docNodes = [];
const docEdges = [];

function dn(type, mention, name, description, excerpt, docId, extra = {}) {
  docNodes.push({ mention, type, name, description, evidence: { locator: docLocator(docId), excerpt, ...extra } });
}
function de(type, source_mention, target_mention, excerpt, docId, extra = {}) {
  docEdges.push({ type, source_mention, target_mention, ...extra, evidence: { locator: docLocator(docId), excerpt } });
}

// --- manual-compras ---------------------------------------------------------
dn('policy', 'Homologación obligatoria de proveedores', 'Homologación obligatoria de proveedores',
  'Solo se compra a proveedores que hayan superado el proceso de homologación y lo mantengan vigente.',
  'Ningún departamento puede comprar materia prima a un proveedor que no figure como homologado en el listado vigente de compras.',
  'manual-compras');
dn('process', 'Homologación de proveedor', 'Homologación de proveedor',
  'Evaluación inicial de un proveedor: calidad de muestras, certificados, solvencia y auditoría documental.',
  'La homologación comprende la revisión de certificados, la evaluación de muestras de bobina y la comprobación de solvencia del proveedor.',
  'manual-compras');
dn('process', 'Evaluación anual de proveedores', 'Evaluación anual de proveedores',
  'Revisión anual del desempeño de cada proveedor homologado: incidencias, plazos y calidad servida.',
  'Cada mes de enero, compras evalúa a todos los proveedores homologados con los datos de incidencias y plazos del año anterior.',
  'manual-compras');
dn('rule', 'Caducidad de certificado de proveedor', 'Caducidad de certificado de proveedor',
  'Un proveedor cuyo certificado de calidad caduque pierde automáticamente la homologación hasta renovarlo.',
  'La caducidad de cualquier certificado obligatorio suspende la homologación del proveedor de forma automática y sin excepciones.',
  'manual-compras');
dn('role', 'Responsable de compras', 'Responsable de compras',
  'Persona que gestiona proveedores, órdenes de compra y la evaluación anual.',
  'El responsable de compras es el único autorizado para homologar proveedores y firmar órdenes de compra de materia prima.',
  'manual-compras');
dn('policy', 'Rotación FIFO de materia prima', 'Rotación FIFO de materia prima',
  'La materia prima se consume por orden estricto de entrada para evitar el envejecimiento del papel.',
  'El papel envejece y pierde propiedades mecánicas: toda bobina se consume por orden de entrada, sin excepciones de conveniencia.',
  'manual-compras');
dn('entity', 'Certificado FSC', 'Certificado FSC',
  'Certificado de cadena de custodia que acredita el origen sostenible del papel comprado y vendido.',
  'El certificado FSC de cadena de custodia ampara tanto el papel comprado como el producto vendido con logotipo FSC.',
  'manual-compras');

de('GOVERNS', 'Homologación obligatoria de proveedores', 'Bloqueo de proveedor no homologado',
  'El sistema de compras impide emitir órdenes a proveedores no homologados en aplicación de esta política.',
  'manual-compras');
de('GOVERNS', 'Homologación obligatoria de proveedores', 'Homologación de proveedor',
  'El proceso de homologación desarrolla esta política y es requisito previo a cualquier compra.',
  'manual-compras');
de('VALIDATES', 'Caducidad de certificado de proveedor', 'Proveedor',
  'Un certificado caducado suspende al proveedor: no puede recibir órdenes hasta acreditar la renovación.',
  'manual-compras');
de('OPERATES_ON', 'Caducidad de certificado de proveedor', 'Proveedor',
  'La suspensión se anota en la ficha del proveedor y se comunica por el portal.',
  'manual-compras');
de('TRIGGERS', 'Certificado caducado', 'Homologación de proveedor',
  'La caducidad de un certificado obliga a repetir la parte documental de la homologación.',
  'manual-compras');
de('EXECUTES', 'Responsable de compras', 'Homologación de proveedor',
  'La homologación la instruye y firma el responsable de compras.',
  'manual-compras');
de('EXECUTES', 'Responsable de compras', 'Evaluación anual de proveedores',
  'La evaluación anual es responsabilidad exclusiva del responsable de compras.',
  'manual-compras');
de('EXECUTES', 'Responsable de compras', 'Aprovisionamiento de bobinas',
  'Las órdenes de bobina que propone el MRP las revisa y firma el responsable de compras antes de su envío.',
  'manual-compras');
de('DEPENDS_ON', 'Evaluación anual de proveedores', 'Proveedor',
  'La evaluación puntúa a cada proveedor homologado con los datos del año anterior.',
  'manual-compras');
de('DEPENDS_ON', 'Homologación de proveedor', 'Certificado FSC',
  'Para papel con sello FSC, la homologación exige certificado de cadena de custodia vigente.',
  'manual-compras');
de('VALIDATES', 'Tolerancia de gramaje en recepción', 'Recepción de bobinas',
  'En recepción se mide el gramaje de cada bobina; una desviación superior a la tolerancia supone el rechazo de la entrega.',
  'manual-compras');
de('GOVERNS', 'Rotación FIFO de materia prima', 'FIFO de bobinas por antigüedad',
  'La regla FIFO del almacén aplica esta política de rotación de materia prima.',
  'manual-compras');
de('GOVERNS', 'Rotación FIFO de materia prima', 'Inventario cíclico',
  'El inventario cíclico verifica, entre otras cosas, que la rotación FIFO se está cumpliendo.',
  'manual-compras');

// --- manual-logistica ---------------------------------------------------------
dn('role', 'Responsable de logística', 'Responsable de logística',
  'Persona que planifica las rutas de reparto y coordina a los transportistas.',
  'El responsable de logística cierra la planificación de rutas antes de las 16:00 del día anterior al reparto.',
  'manual-logistica');
dn('role', 'Jefe de almacén', 'Jefe de almacén',
  'Persona que dirige recepción, ubicación, inventario y preparación de pedidos en el almacén.',
  'El jefe de almacén responde del cuadre de stock y de la secuencia de preparación de pedidos.',
  'manual-logistica');
dn('rule', 'Doble verificación de carga', 'Doble verificación de carga',
  'Cada palet cargado se verifica dos veces: el carretillero al subirlo y el jefe de almacén contra el albarán.',
  'Ningún camión sale sin la doble verificación: el carretillero cuenta los palets al cargar y el jefe de almacén los coteja con el albarán.',
  'manual-logistica');

de('EXECUTES', 'Responsable de logística', 'Planificación de rutas de reparto',
  'La planificación diaria de rutas la ejecuta el responsable de logística con la propuesta del optimizador.',
  'manual-logistica');
de('EXECUTES', 'Jefe de almacén', 'Picking de expedición',
  'El picking se realiza bajo la dirección del jefe de almacén siguiendo la cola del SGA.',
  'manual-logistica');
de('EXECUTES', 'Jefe de almacén', 'Inventario cíclico',
  'El recuento cíclico semanal lo organiza y firma el jefe de almacén.',
  'manual-logistica');
de('EXECUTES', 'Jefe de almacén', 'Recepción de bobinas',
  'La recepción de materia prima está a cargo del equipo de almacén y la firma su jefe.',
  'manual-logistica');
de('VALIDATES', 'Doble verificación de carga', 'Carga de camión',
  'La carga no se da por terminada hasta completar la segunda verificación contra el albarán.',
  'manual-logistica');
de('OPERATES_ON', 'Doble verificación de carga', 'Albarán',
  'El cotejo final se hace palet a palet contra las líneas del albarán.',
  'manual-logistica');
de('VALIDATES', 'Carga máxima por camión', 'Carga de camión',
  'Está prohibido cargar por encima de la capacidad del vehículo aunque la ruta quede incompleta.',
  'manual-logistica');
de('GOVERNS', 'Prevención de riesgos laborales', 'Carga de camión',
  'Las operaciones de carga se realizan conforme al plan de prevención: calzos, chaleco y carretilla autorizada.',
  'manual-logistica');
de('EXECUTES', 'Responsable de logística', 'Carga de camión',
  'El responsable de logística autoriza cada salida de camión una vez verificada la carga.',
  'manual-logistica');

// --- manual-calidad -----------------------------------------------------------
dn('entity', 'No conformidad', 'No conformidad',
  'Registro de un incumplimiento de calidad detectado en producción, recepción o reclamación de cliente.',
  'Toda desviación de calidad se registra como no conformidad con su origen, alcance y acción correctiva.',
  'manual-calidad');
dn('entity', 'Muestra de calidad', 'Muestra de calidad',
  'Cajas apartadas de una tirada para el control de calidad y su archivo posterior.',
  'De cada tirada se apartan muestras identificadas con el número de orden de fabricación.',
  'manual-calidad');
dn('entity', 'Plancha de cartón', 'Plancha de cartón',
  'Plancha ondulada resultante del proceso de ondulado, materia prima del troquelado.',
  'La plancha de cartón ondulado se identifica por calidad, gramaje total y medidas.',
  'manual-calidad');
dn('entity', 'Caja troquelada', 'Caja troquelada',
  'Producto terminado: caja cortada, hendida y en su caso impresa, lista para plegado.',
  'La caja troquelada debe respetar las medidas del plano del troquel dentro de la tolerancia dimensional.',
  'manual-calidad');
dn('process', 'Gestión de no conformidades', 'Gestión de no conformidades',
  'Apertura, análisis de causa, acción correctiva y cierre de las no conformidades.',
  'Cada no conformidad tiene un responsable, una causa raíz documentada y una acción correctiva con plazo.',
  'manual-calidad');
dn('process', 'Auditoría interna de calidad', 'Auditoría interna de calidad',
  'Auditoría semestral del sistema de calidad: procesos, registros y no conformidades abiertas.',
  'Dos veces al año se audita internamente el sistema: muestreos, registros de tirada y estado de las no conformidades.',
  'manual-calidad');
dn('rule', 'Rechazo por delaminación', 'Rechazo por delaminación',
  'Una plancha o caja con delaminación visible del ondulado se rechaza sin excepción.',
  'La delaminación del canal es defecto crítico: la unidad afectada se rechaza y se revisa el lote completo.',
  'manual-calidad');
dn('rule', 'Tolerancia dimensional de troquel', 'Tolerancia dimensional de troquel',
  'Las medidas de la caja troquelada no pueden desviarse más de 1,5 mm de las del plano.',
  'Se admite una desviación máxima de ±1,5 mm respecto al plano del troquel; superada, la tirada se detiene.',
  'manual-calidad');
dn('rule', 'Muestreo mínimo por tirada', 'Muestreo mínimo por tirada',
  'De cada tirada se controlan al menos 5 cajas: primera, última y tres intermedias aleatorias.',
  'El muestreo mínimo es de cinco cajas por tirada: la primera, la última y tres intermedias tomadas al azar.',
  'manual-calidad');
dn('rule', 'Retención de muestras de calidad', 'Retención de muestras de calidad',
  'Las muestras de cada tirada se archivan durante un año por trazabilidad.',
  'Las muestras se conservan doce meses identificadas por orden de fabricación, por si hay reclamación del cliente.',
  'manual-calidad');
dn('rule', 'Cierre de no conformidad en plazo', 'Cierre de no conformidad en plazo',
  'Toda no conformidad debe cerrarse con acción correctiva verificada en un máximo de 30 días.',
  'El plazo máximo de cierre es de treinta días; pasado el plazo, la no conformidad escala al comité de calidad.',
  'manual-calidad');
dn('rule', 'Merma máxima por humedad', 'Merma máxima por humedad',
  'Una bobina almacenada con humedad relativa fuera de rango se aparta si su merma estimada supera el 3%.',
  'Si la humedad del almacén sale de rango, las bobinas expuestas se revisan y se apartan cuando la merma estimada supera el 3%.',
  'manual-calidad');
dn('policy', 'Trazabilidad de tirada', 'Trazabilidad de tirada',
  'Cada caja servida debe poder rastrearse hasta su tirada, bobina de origen y controles superados.',
  'La trazabilidad es total: de la caja al número de tirada, de la tirada a la bobina y de la bobina al proveedor.',
  'manual-calidad');
dn('role', 'Jefe de calidad', 'Jefe de calidad',
  'Persona que mantiene el sistema de calidad, las auditorías y el cierre de no conformidades.',
  'El jefe de calidad preside el comité mensual y firma el cierre de cada no conformidad.',
  'manual-calidad');
dn('entity', 'Reclamación', 'Reclamación',
  'Queja formal de un cliente por calidad, plazo o cantidad servida.',
  'Toda reclamación de cliente se registra el mismo día y se vincula al pedido y a la tirada afectada.',
  'manual-calidad');
dn('event', 'No conformidad abierta', 'No conformidad abierta',
  'Se ha registrado una nueva no conformidad en el sistema de calidad.',
  'La apertura de una no conformidad notifica automáticamente al responsable del proceso afectado.',
  'manual-calidad');

de('GOVERNS', 'Trazabilidad de tirada', 'Muestreo mínimo por tirada',
  'El muestreo por tirada es una de las garantías de la política de trazabilidad.',
  'manual-calidad');
de('GOVERNS', 'Trazabilidad de tirada', 'Gestión de no conformidades',
  'La gestión de no conformidades exige poder rastrear el lote afectado; la trazabilidad lo hace posible.',
  'manual-calidad');
de('GOVERNS', 'Trazabilidad de tirada', 'Retención de muestras de calidad',
  'El archivo de muestras materializa la trazabilidad hacia atrás durante un año.',
  'manual-calidad');
de('GOVERNS', 'Calidad obligatoria por tirada', 'Rechazo por delaminación',
  'El rechazo por delaminación desarrolla la política de calidad por tirada para el defecto más grave del ondulado.',
  'manual-calidad');
de('VALIDATES', 'Rechazo por delaminación', 'Control de calidad de tirada',
  'El control de tirada incluye la inspección de delaminación en las muestras tomadas.',
  'manual-calidad');
de('OPERATES_ON', 'Rechazo por delaminación', 'Plancha de cartón',
  'La delaminación se inspecciona sobre la plancha y sobre la caja terminada.',
  'manual-calidad');
de('VALIDATES', 'Tolerancia dimensional de troquel', 'Caja troquelada',
  'Las medidas de la caja se comprueban contra el plano en cada muestreo.',
  'manual-calidad');
de('OPERATES_ON', 'Tolerancia dimensional de troquel', 'Troquel',
  'Una desviación repetida fuera de tolerancia obliga a revisar el estado del troquel.',
  'manual-calidad');
de('VALIDATES', 'Muestreo mínimo por tirada', 'Control de calidad de tirada',
  'No hay control de tirada válido sin el muestreo mínimo de cinco cajas.',
  'manual-calidad');
de('OPERATES_ON', 'Muestreo mínimo por tirada', 'Muestra de calidad',
  'Las cinco cajas del muestreo se registran como muestras de la tirada.',
  'manual-calidad');
de('VALIDATES', 'Retención de muestras de calidad', 'Muestra de calidad',
  'Una muestra no archivada en plazo invalida el registro de la tirada.',
  'manual-calidad');
de('VALIDATES', 'Cierre de no conformidad en plazo', 'Gestión de no conformidades',
  'El proceso no se considera conforme si alguna no conformidad supera el plazo de cierre.',
  'manual-calidad');
de('OPERATES_ON', 'Cierre de no conformidad en plazo', 'No conformidad',
  'El plazo se cuenta desde la fecha de apertura registrada en la no conformidad.',
  'manual-calidad');
de('TRIGGERS', 'No conformidad abierta', 'Gestión de no conformidades',
  'La apertura arranca el ciclo de análisis de causa y acción correctiva.',
  'manual-calidad');
de('TRIGGERS', 'Gestión de reclamaciones', 'No conformidad abierta',
  'Toda reclamación de cliente con causa interna abre su no conformidad asociada.',
  'manual-calidad');
de('DEPENDS_ON', 'Gestión de reclamaciones', 'Reclamación',
  'El proceso se instruye sobre el registro de la reclamación y su tirada vinculada.',
  'manual-calidad');
de('EXECUTES', 'Jefe de calidad', 'Gestión de no conformidades',
  'El jefe de calidad asigna el análisis de causa y firma cada cierre.',
  'manual-calidad');
de('EXECUTES', 'Jefe de calidad', 'Auditoría interna de calidad',
  'Las auditorías internas las planifica y dirige el jefe de calidad.',
  'manual-calidad');
de('DEPENDS_ON', 'Auditoría interna de calidad', 'No conformidad',
  'La auditoría revisa el estado y los plazos de todas las no conformidades abiertas.',
  'manual-calidad');
de('OPERATES_ON', 'Merma máxima por humedad', 'Bobina',
  'La merma estimada por humedad se anota sobre cada bobina afectada.',
  'manual-calidad');
de('VALIDATES', 'Merma máxima por humedad', 'Recepción de bobinas',
  'En recepción se rechazan las bobinas cuya merma estimada por humedad supere el máximo.',
  'manual-calidad');

// --- plan-mantenimiento ---------------------------------------------------------
dn('entity', 'Troqueladora', 'Troqueladora',
  'Máquina de troquelado plano que corta y hiende las planchas con el troquel montado.',
  'La troqueladora plana admite formatos hasta 1.600 mm y registra horas de uso por contador.',
  'plan-mantenimiento');
dn('entity', 'Onduladora', 'Onduladora',
  'Máquina que fabrica la plancha de cartón ondulado a partir de bobinas de papel.',
  'La onduladora combina liner y tripa a partir de tres portabobinas y produce plancha en continuo.',
  'plan-mantenimiento');
dn('entity', 'Parte de mantenimiento', 'Parte de mantenimiento',
  'Registro de una intervención de mantenimiento: máquina, tipo, horas y repuestos.',
  'Toda intervención, preventiva o por avería, genera su parte de mantenimiento firmado.',
  'plan-mantenimiento');
dn('process', 'Mantenimiento preventivo', 'Mantenimiento preventivo',
  'Intervenciones planificadas por horas de uso o calendario para evitar averías.',
  'El preventivo se planifica por contador de horas o por calendario, lo que antes venza.',
  'plan-mantenimiento');
dn('process', 'Reparación de averías', 'Reparación de averías',
  'Intervención correctiva no planificada tras la avería de una máquina.',
  'Ante avería, el técnico abre parte, diagnostica y repara; la máquina no vuelve a producción sin su firma.',
  'plan-mantenimiento');
dn('process', 'Cambio de troquel', 'Cambio de troquel',
  'Sustitución del troquel en máquina entre tiradas, con ajuste y prueba de primera caja.',
  'El cambio de troquel incluye limpieza de platina, montaje, ajuste de presión y validación de la primera caja.',
  'plan-mantenimiento');
dn('process', 'Ondulado', 'Ondulado',
  'Fabricación de plancha de cartón ondulado a partir de bobinas de papel.',
  'El ondulado transforma bobinas de liner y tripa en plancha según la receta de calidad.',
  'plan-mantenimiento');
dn('process', 'Calibración de troqueladora', 'Calibración de troqueladora',
  'Ajuste periódico de presiones y registros de la troqueladora contra patrón.',
  'La calibración trimestral ajusta presión de corte y registro de impresión contra plancha patrón.',
  'plan-mantenimiento');
dn('rule', 'Parada por horas de uso de troqueladora', 'Parada por horas de uso de troqueladora',
  'La troqueladora se detiene para preventivo cada 400 horas de uso registradas por contador.',
  'Cada 400 horas de contador, la troqueladora se para para su preventivo; el arranque posterior requiere firma del técnico.',
  'plan-mantenimiento');
dn('rule', 'Frecuencia de engrase de onduladora', 'Frecuencia de engrase de onduladora',
  'Los rodamientos de la onduladora se engrasan cada semana natural, con registro en el parte.',
  'El engrase semanal de rodamientos es obligatorio y queda registrado en el parte de mantenimiento.',
  'plan-mantenimiento');
dn('policy', 'Mantenimiento preventivo planificado', 'Mantenimiento preventivo planificado',
  'El mantenimiento se planifica; la avería es la excepción y se analiza siempre a posteriori.',
  'La política de la planta es preventiva: toda avería repetida obliga a revisar el plan de mantenimiento de esa máquina.',
  'plan-mantenimiento');
dn('role', 'Técnico de mantenimiento', 'Técnico de mantenimiento',
  'Persona que ejecuta preventivos, repara averías y firma los partes de mantenimiento.',
  'El técnico de mantenimiento firma cada parte y autoriza el arranque tras cada intervención.',
  'plan-mantenimiento');
dn('event', 'Avería de máquina', 'Avería de máquina',
  'Parada no planificada de una máquina de producción por fallo mecánico o eléctrico.',
  'La avería se comunica de inmediato al técnico de guardia y detiene la planificación de la máquina.',
  'plan-mantenimiento');

de('GOVERNS', 'Mantenimiento preventivo planificado', 'Mantenimiento preventivo',
  'El proceso de preventivo desarrolla la política de mantenimiento planificado.',
  'plan-mantenimiento');
de('GOVERNS', 'Mantenimiento preventivo planificado', 'Parada por horas de uso de troqueladora',
  'La parada por horas es la aplicación de la política preventiva a la troqueladora.',
  'plan-mantenimiento');
de('VALIDATES', 'Parada por horas de uso de troqueladora', 'Mantenimiento preventivo',
  'El preventivo de la troqueladora se realiza a las 400 horas de contador; no se admite aplazarlo.',
  'plan-mantenimiento');
de('OPERATES_ON', 'Parada por horas de uso de troqueladora', 'Troqueladora',
  'El contador de horas de la troqueladora dispara la parada preventiva.',
  'plan-mantenimiento');
de('VALIDATES', 'Frecuencia de engrase de onduladora', 'Mantenimiento preventivo',
  'El engrase semanal forma parte del preventivo mínimo de la onduladora.',
  'plan-mantenimiento');
de('OPERATES_ON', 'Frecuencia de engrase de onduladora', 'Onduladora',
  'El engrase afecta a los rodamientos de los portabobinas y del puente.',
  'plan-mantenimiento');
de('EXECUTES', 'Técnico de mantenimiento', 'Mantenimiento preventivo',
  'Los preventivos los ejecuta el técnico de mantenimiento según el plan anual.',
  'plan-mantenimiento');
de('EXECUTES', 'Técnico de mantenimiento', 'Reparación de averías',
  'Las averías las atiende el técnico de guardia, que firma la vuelta a producción.',
  'plan-mantenimiento');
de('EXECUTES', 'Técnico de mantenimiento', 'Calibración de troqueladora',
  'La calibración trimestral la realiza el técnico con la plancha patrón.',
  'plan-mantenimiento');
de('TRIGGERS', 'Avería de máquina', 'Reparación de averías',
  'La comunicación de avería abre el parte y moviliza al técnico de guardia.',
  'plan-mantenimiento');
de('DEPENDS_ON', 'Mantenimiento preventivo', 'Parte de mantenimiento',
  'Sin parte firmado, el preventivo no se considera realizado.',
  'plan-mantenimiento');
de('DEPENDS_ON', 'Reparación de averías', 'Parte de mantenimiento',
  'La reparación queda documentada en su parte, con causa y repuestos.',
  'plan-mantenimiento');
de('DEPENDS_ON', 'Troquelado', 'Troqueladora',
  'No hay tirada sin troqueladora operativa y con preventivo al día.',
  'plan-mantenimiento');
de('DEPENDS_ON', 'Ondulado', 'Onduladora',
  'El ondulado depende de la onduladora, única en la planta.',
  'plan-mantenimiento');
de('DEPENDS_ON', 'Ondulado', 'Bobina',
  'El ondulado consume bobinas de liner y tripa según la receta de la calidad.',
  'plan-mantenimiento');
de('PART_OF', 'Cambio de troquel', 'Troquelado',
  'El cambio de troquel es la fase inicial de cada tirada de troquelado.',
  'plan-mantenimiento');
de('PART_OF', 'Calibración de troqueladora', 'Mantenimiento preventivo',
  'La calibración es una gama más dentro del preventivo de la troqueladora.',
  'plan-mantenimiento');
de('TRIGGERS', 'Ondulado', 'Troquelado',
  'La plancha ondulada pasa a la sección de troquelado según la secuencia de órdenes.',
  'plan-mantenimiento');

// --- normativa-rrhh -------------------------------------------------------------
dn('entity', 'Turno', 'Turno',
  'Franja de trabajo de producción: mañana, tarde o noche, con su equipo asignado.',
  'La planta trabaja a tres turnos de lunes a viernes; el de noche solo en campaña.',
  'normativa-rrhh');
dn('entity', 'Parte de horas', 'Parte de horas',
  'Registro diario de horas ordinarias y extraordinarias de cada operario.',
  'El parte de horas se cierra a diario y es la base de la nómina y del control de horas extra.',
  'normativa-rrhh');
dn('process', 'Cuadrante de turnos', 'Cuadrante de turnos',
  'Elaboración mensual del cuadrante: asignación de operarios a turnos y máquinas.',
  'El cuadrante se publica antes del día 25 del mes anterior y respeta los descansos legales.',
  'normativa-rrhh');
dn('process', 'Registro de partes de horas', 'Registro de partes de horas',
  'Recogida y validación diaria de los partes de horas de todos los operarios.',
  'Los partes se validan a diario; las horas extra requieren visto bueno previo del jefe de producción.',
  'normativa-rrhh');
dn('rule', 'Descanso mínimo entre turnos', 'Descanso mínimo entre turnos',
  'Entre el final de un turno y el inicio del siguiente deben mediar al menos 12 horas.',
  'Ningún operario puede encadenar turnos sin un descanso mínimo de doce horas entre ambos.',
  'normativa-rrhh');
dn('rule', 'Máximo de horas extra mensuales', 'Máximo de horas extra mensuales',
  'Ningún operario puede superar las 15 horas extraordinarias en un mes natural.',
  'El tope de horas extraordinarias es de quince al mes; superado, el parte se rechaza automáticamente.',
  'normativa-rrhh');
dn('policy', 'Prevención de riesgos laborales', 'Prevención de riesgos laborales',
  'Política de seguridad de la planta: formación, equipos de protección y procedimientos seguros.',
  'La seguridad prima sobre la producción: cualquier operario puede detener una operación insegura.',
  'normativa-rrhh');
dn('role', 'Responsable de RRHH', 'Responsable de RRHH',
  'Persona que gestiona cuadrantes, partes de horas, nómina y formación.',
  'El responsable de RRHH publica el cuadrante y custodia los registros horarios.',
  'normativa-rrhh');
dn('role', 'Operario de troquelado', 'Operario de troquelado',
  'Operario de la sección de troquelado: maneja la troqueladora y realiza el cambio de troquel.',
  'El operario de troquelado maneja la máquina, cambia troqueles y toma las muestras de calidad de su tirada.',
  'normativa-rrhh');
dn('event', 'Fin de turno', 'Fin de turno',
  'Cierre de una franja de trabajo con el relevo del turno entrante.',
  'Al fin de turno, el saliente registra su parte y transmite las incidencias al entrante.',
  'normativa-rrhh');

de('GOVERNS', 'Prevención de riesgos laborales', 'Cuadrante de turnos',
  'El cuadrante debe respetar los descansos y límites que fija el plan de prevención.',
  'normativa-rrhh');
de('VALIDATES', 'Descanso mínimo entre turnos', 'Cuadrante de turnos',
  'RRHH no publica un cuadrante que incumpla el descanso mínimo de doce horas.',
  'normativa-rrhh');
de('OPERATES_ON', 'Descanso mínimo entre turnos', 'Turno',
  'El descanso se comprueba entre el fin de un turno y el inicio del siguiente asignado.',
  'normativa-rrhh');
de('VALIDATES', 'Máximo de horas extra mensuales', 'Registro de partes de horas',
  'El registro rechaza el parte que haga superar el tope mensual de horas extra.',
  'normativa-rrhh');
de('OPERATES_ON', 'Máximo de horas extra mensuales', 'Parte de horas',
  'El acumulado mensual se calcula sobre los partes de horas validados.',
  'normativa-rrhh');
de('EXECUTES', 'Responsable de RRHH', 'Cuadrante de turnos',
  'El cuadrante lo elabora y publica el responsable de RRHH.',
  'normativa-rrhh');
de('EXECUTES', 'Responsable de RRHH', 'Registro de partes de horas',
  'La validación diaria de partes corresponde a RRHH.',
  'normativa-rrhh');
de('TRIGGERS', 'Fin de turno', 'Registro de partes de horas',
  'El cierre de turno obliga a registrar el parte antes de abandonar la planta.',
  'normativa-rrhh');
de('EXECUTES', 'Operario de troquelado', 'Troquelado',
  'La tirada la ejecuta el operario de troquelado asignado en el cuadrante.',
  'normativa-rrhh');
de('EXECUTES', 'Operario de troquelado', 'Cambio de troquel',
  'El cambio de troquel lo realiza el propio operario de la máquina.',
  'normativa-rrhh');
de('DEPENDS_ON', 'Cuadrante de turnos', 'Turno',
  'El cuadrante asigna personas a los turnos definidos de la planta.',
  'normativa-rrhh');

// --- politica-medioambiental ------------------------------------------------------
dn('entity', 'Residuo de cartón', 'Residuo de cartón',
  'Recorte y merma de cartón generados por ondulado y troquelado, destinados a reciclaje.',
  'El recorte de troquelado y la merma de ondulado se compactan y venden como residuo valorizable.',
  'politica-medioambiental');
dn('process', 'Gestión de residuos', 'Gestión de residuos',
  'Segregación, compactado, pesaje y retirada de los residuos de la planta.',
  'Los residuos se segregan en origen, se compactan y se retiran por gestor autorizado con pesaje documentado.',
  'politica-medioambiental');
dn('process', 'Renovación del certificado FSC', 'Renovación del certificado FSC',
  'Auditoría anual de cadena de custodia para mantener vigente el certificado FSC.',
  'La renovación FSC exige superar la auditoría anual de cadena de custodia y mantener los registros de compra.',
  'politica-medioambiental');
dn('rule', 'Separación de residuos por tipo', 'Separación de residuos por tipo',
  'Los residuos se separan en origen: cartón, plástico de flejado, tintas y peligrosos.',
  'Está prohibido mezclar fracciones: cada residuo va a su contenedor identificado desde el punto de generación.',
  'politica-medioambiental');
dn('rule', 'Porcentaje mínimo de fibra reciclada', 'Porcentaje mínimo de fibra reciclada',
  'Las calidades estándar de plancha deben incorporar al menos un 70% de fibra reciclada.',
  'Salvo pedido con requisito específico, la plancha estándar se fabrica con un mínimo del 70% de fibra reciclada.',
  'politica-medioambiental');
dn('policy', 'Sostenibilidad y reciclaje', 'Sostenibilidad y reciclaje',
  'Compromiso ambiental de la planta: maximizar fibra reciclada y valorizar todos los residuos.',
  'Acme se compromete a valorizar el 100% de su residuo de cartón y a maximizar la fibra reciclada en sus calidades.',
  'politica-medioambiental');
dn('event', 'Residuo retirado', 'Residuo retirado',
  'El gestor autorizado ha retirado y pesado un contenedor de residuo.',
  'Cada retirada queda documentada con albarán del gestor y pesaje de báscula.',
  'politica-medioambiental');
dn('event', 'Certificado caducado', 'Certificado caducado',
  'Un certificado obligatorio (FSC u homologación de proveedor) ha llegado a su fecha de caducidad.',
  'El sistema avisa 60 días antes de la caducidad de cualquier certificado registrado.',
  'politica-medioambiental');

de('GOVERNS', 'Sostenibilidad y reciclaje', 'Gestión de residuos',
  'La gestión de residuos desarrolla el compromiso de valorización total.',
  'politica-medioambiental');
de('GOVERNS', 'Sostenibilidad y reciclaje', 'Porcentaje mínimo de fibra reciclada',
  'El mínimo de fibra reciclada materializa la política en las calidades estándar.',
  'politica-medioambiental');
de('GOVERNS', 'Sostenibilidad y reciclaje', 'Renovación del certificado FSC',
  'Mantener el certificado FSC vigente es un compromiso público de la política ambiental.',
  'politica-medioambiental');
de('VALIDATES', 'Separación de residuos por tipo', 'Gestión de residuos',
  'Una fracción mezclada invalida la retirada y se reprocesa como residuo no segregado.',
  'politica-medioambiental');
de('OPERATES_ON', 'Separación de residuos por tipo', 'Residuo de cartón',
  'El cartón compactado no admite plástico de flejado ni tintas.',
  'politica-medioambiental');
de('OPERATES_ON', 'Porcentaje mínimo de fibra reciclada', 'Bobina',
  'El porcentaje de fibra reciclada se controla en la compra de bobinas por calidad.',
  'politica-medioambiental');
de('TRIGGERS', 'Gestión de residuos', 'Residuo retirado',
  'La retirada por el gestor cierra el ciclo de cada contenedor compactado.',
  'politica-medioambiental');
de('DEPENDS_ON', 'Renovación del certificado FSC', 'Certificado FSC',
  'La auditoría anual renueva la vigencia del certificado de cadena de custodia.',
  'politica-medioambiental');
de('TRIGGERS', 'Certificado caducado', 'Renovación del certificado FSC',
  'El aviso de caducidad arranca la preparación de la auditoría de renovación.',
  'politica-medioambiental');
de('DEPENDS_ON', 'Gestión de residuos', 'Residuo de cartón',
  'El grueso del volumen gestionado es el recorte de cartón de troquelado.',
  'politica-medioambiental');

// --- manual-comercial (additions) + manual-administracion -----------------------
dn('process', 'Revisión anual de tarifas', 'Revisión anual de tarifas',
  'Actualización anual de la tarifa general según coste del papel y estudio de mercado.',
  'La tarifa general se revisa cada enero con el coste medio del papel del semestre anterior.',
  'manual-comercial');
dn('rule', 'Ajuste de tarifa por coste de papel', 'Ajuste de tarifa por coste de papel',
  'Si el coste del papel varía más de un 8% desde la última revisión, la tarifa se actualiza fuera de ciclo.',
  'Una variación del coste del papel superior al 8% obliga a actualizar la tarifa sin esperar a la revisión anual.',
  'manual-comercial');
dn('policy', 'Revisión anual de precios', 'Revisión anual de precios',
  'Los precios se revisan de forma ordenada una vez al año, con excepciones tasadas.',
  'La empresa revisa precios una vez al año; solo la cláusula de coste de papel permite revisiones extraordinarias.',
  'manual-comercial');
dn('rule', 'Descuento por volumen', 'Descuento por volumen',
  'Descuento aplicado sobre el precio unitario a partir de un umbral de cantidad por línea.',
  'El descuento por volumen vigente es del 10% a partir de 8.000 unidades por línea; la tabla anterior (8% desde 5.000) queda sin efecto desde enero de 2026.',
  'manual-comercial');
dn('entity', 'Línea de pedido', 'Línea de pedido',
  'Línea de un pedido de venta: referencia, cantidad y precio unitario.',
  'El descuento por volumen se calcula línea a línea, nunca sobre el total del pedido.',
  'manual-comercial');
dn('policy', 'Crédito controlado por cliente', 'Crédito controlado por cliente',
  'Todo cliente tiene un límite de crédito asignado y revisado periódicamente; el riesgo vivo no puede superarlo.',
  'Ningún cliente puede acumular más riesgo vivo que su límite asignado; los límites se revisan al menos una vez al año.',
  'manual-administracion');
dn('policy', 'Retención documental', 'Retención documental',
  'Facturas, albaranes y partes se conservan el plazo legal: seis años los contables, uno los operativos.',
  'La documentación contable se conserva seis años; los registros operativos, al menos doce meses.',
  'manual-administracion');
dn('role', 'Contable', 'Contable',
  'Persona que asienta facturas y abonos, concilia cobros y prepara el cierre mensual.',
  'El contable ejecuta el cierre mensual y responde de la conciliación bancaria.',
  'manual-administracion');
dn('process', 'Reclamación de impagos', 'Reclamación de impagos',
  'Avisos y llamadas por facturas vencidas hasta su cobro o escalado.',
  'Administración reclama los vencidos con tres avisos escalonados antes de pasar el expediente a jurídico.',
  'manual-administracion');
dn('process', 'Cierre contable mensual', 'Cierre contable mensual',
  'Conciliación y asiento del mes: facturas, abonos, cobros y provisiones.',
  'El cierre se completa antes del día 10 del mes siguiente, con todas las facturas y abonos asentados.',
  'manual-administracion');
dn('process', 'Emisión de abonos', 'Emisión de abonos',
  'Emisión de rectificativas por devoluciones o errores, con aprobación previa.',
  'Todo abono requiere motivo tasado y visto bueno de administración antes de su emisión.',
  'manual-administracion');
dn('process', 'Elaboración de presupuestos', 'Elaboración de presupuestos',
  'Confección de ofertas con tarifa vigente, amortización de troquel y margen.',
  'El presupuesto parte de la tarifa vigente; cualquier descuento adicional se rige por los límites del comercial.',
  'manual-comercial');
dn('entity', 'Tarifa', 'Tarifa',
  'Lista de precios vigente por calidad y tramo de cantidad.',
  'La tarifa vigente es la única base admitida para presupuestar.',
  'manual-comercial');
dn('entity', 'Proveedor', 'Proveedor',
  'Suministrador de materia prima sujeto a homologación y evaluación anual.',
  'Los proveedores de papel se clasifican por calidad servida y cumplimiento de plazos.',
  'manual-compras');
dn('event', 'Factura vencida', 'Factura vencida',
  'Una factura ha superado su vencimiento sin cobro registrado.',
  'El listado de vencidos se revisa a diario en administración.',
  'manual-administracion');
dn('role', 'Comercial', 'Comercial',
  'Rol que capta pedidos, presupuesta y negocia condiciones dentro de sus límites.',
  'El comercial presupuesta con la tarifa vigente y no puede rebasar su descuento máximo autorizado.',
  'manual-comercial');
dn('role', 'Administración', 'Administración',
  'Rol responsable de facturación, cobros y reclamación de vencidos.',
  'Administración emite la facturación mensual y gestiona la reclamación de impagos.',
  'manual-administracion');
dn('rule', 'Carga máxima por camión', 'Carga máxima por camión',
  'La carga de una ruta no puede superar la capacidad del vehículo asignado.',
  'Por seguridad vial, la carga por camión no supera nunca la capacidad homologada del vehículo.',
  'manual-logistica');
dn('rule', 'Tolerancia de gramaje en recepción', 'Tolerancia de gramaje en recepción',
  'La bobina cuyo gramaje medido se desvía más de la tolerancia se devuelve al proveedor.',
  'La desviación de gramaje admitida en recepción es del 4%; por encima, la entrega se rechaza.',
  'manual-compras');
dn('entity', 'Bobina', 'Bobina',
  'Bobina de papel, materia prima del ondulado.',
  'Las bobinas se almacenan en vertical, protegidas de la humedad, y rotan por orden de entrada.',
  'manual-compras');
dn('rule', 'FIFO de bobinas por antigüedad', 'FIFO de bobinas por antigüedad',
  'Consumo de bobinas por orden estricto de entrada.',
  'El almacén sirve siempre la bobina más antigua de cada gramaje; el SGA lo impone.',
  'manual-compras');
dn('rule', 'Bloqueo de proveedor no homologado', 'Bloqueo de proveedor no homologado',
  'No se emiten órdenes de compra a proveedores sin homologación vigente.',
  'El sistema no permite emitir órdenes a proveedores fuera del listado de homologados.',
  'manual-compras');
dn('entity', 'Albarán', 'Albarán',
  'Documento de entrega firmado por el cliente en destino.',
  'El albarán firmado es imprescindible para facturar la entrega.',
  'manual-logistica');
dn('entity', 'Troquel', 'Troquel',
  'Herramienta de corte, propiedad del cliente o de Acme, con vida útil controlada.',
  'Los troqueles se almacenan identificados y su estado se revisa tras cada tirada.',
  'manual-calidad');
dn('process', 'Aprovisionamiento de bobinas', 'Aprovisionamiento de bobinas',
  'Compra de bobinas a proveedores homologados según necesidades del MRP.',
  'Las propuestas de compra del MRP se revisan y firman antes de su envío al proveedor.',
  'manual-compras');
dn('process', 'Recepción de bobinas', 'Recepción de bobinas',
  'Control de entrada y ubicación de las bobinas entregadas.',
  'Toda entrega de bobinas pasa control de gramaje, humedad y aspecto antes de ubicarse.',
  'manual-compras');
dn('process', 'Inventario cíclico', 'Inventario cíclico',
  'Recuento rotativo para cuadrar stock físico y sistema.',
  'El recuento cíclico cubre todas las ubicaciones al menos una vez por trimestre.',
  'manual-logistica');
dn('process', 'Picking de expedición', 'Picking de expedición',
  'Preparación de palets de pedido para su carga.',
  'El picking sigue estrictamente la cola del SGA, que antepone los pedidos urgentes.',
  'manual-logistica');
dn('process', 'Planificación de rutas de reparto', 'Planificación de rutas de reparto',
  'Asignación de entregas a rutas y transportistas.',
  'Las rutas se agrupan por zonas de código postal para reducir kilómetros en vacío.',
  'manual-logistica');
dn('process', 'Carga de camión', 'Carga de camión',
  'Carga verificada de los palets de una ruta.',
  'La carga se hace por orden inverso de reparto y con doble verificación.',
  'manual-logistica');
dn('process', 'Control de límite de crédito', 'Control de límite de crédito',
  'Recálculo del riesgo vivo por cliente.',
  'El riesgo vivo se recalcula con cada factura emitida y cada cobro registrado.',
  'manual-administracion');
dn('rule', 'Bloqueo por límite de crédito excedido', 'Bloqueo por límite de crédito excedido',
  'Ningún pedido puede hacer superar al cliente su límite de crédito.',
  'Los pedidos que superen el límite de crédito del cliente quedan retenidos hasta su regularización.',
  'manual-administracion');
dn('process', 'Control de calidad de tirada', 'Control de calidad de tirada',
  'Inspección por muestreo de cada tirada de troquelado.',
  'El control de tirada verifica medidas, hendidos, impresión y ausencia de delaminación.',
  'manual-calidad');
dn('process', 'Gestión de reclamaciones', 'Gestión de reclamaciones',
  'Atención y resolución de las reclamaciones de clientes.',
  'La reclamación se responde en 48 horas y, si procede, abre no conformidad y abono.',
  'manual-calidad');
dn('policy', 'Calidad obligatoria por tirada', 'Calidad obligatoria por tirada',
  'Ninguna tirada se sirve sin su control de calidad registrado.',
  'No se expide producto de una tirada sin control de calidad firmado.',
  'manual-calidad');
dn('process', 'Troquelado', 'Troquelado',
  'Corte y hendido de planchas con troquel en máquina.',
  'El troquelado se planifica por órdenes de fabricación agrupadas por calidad.',
  'manual-calidad');
dn('event', 'Fin de mes', 'Fin de mes',
  'Cierre del periodo mensual de facturación.',
  'El fin de mes dispara la facturación agrupada y el posterior cierre contable.',
  'manual-administracion');
dn('process', 'Facturación mensual', 'Facturación mensual',
  'Emisión de facturas agrupadas del mes.',
  'La facturación agrupa los albaranes firmados del mes por cliente.',
  'manual-administracion');

de('GOVERNS', 'Revisión anual de precios', 'Revisión anual de tarifas',
  'La revisión anual de tarifas ejecuta la política de precios de la casa.',
  'manual-comercial');
de('GOVERNS', 'Revisión anual de precios', 'Ajuste de tarifa por coste de papel',
  'La cláusula de coste de papel es la única excepción admitida a la revisión anual.',
  'manual-comercial');
de('CALCULATES', 'Ajuste de tarifa por coste de papel', 'Tarifa',
  'La tarifa se recalcula aplicando la variación del coste medio del papel.',
  'manual-comercial', { attrs: { attribute: 'precio_base' } });
de('DEPENDS_ON', 'Revisión anual de tarifas', 'Tarifa',
  'La revisión parte de la tarifa vigente y del coste medio del papel del semestre.',
  'manual-comercial');
de('EXECUTES', 'Comercial', 'Elaboración de presupuestos',
  'Los presupuestos los elabora el comercial de la cuenta con la tarifa vigente.',
  'manual-comercial');
de('CALCULATES', 'Descuento por volumen', 'Línea de pedido',
  'El descuento por volumen vigente es del 10% a partir de 8.000 unidades por línea; queda sin efecto la tabla anterior del 8% desde 5.000 unidades.',
  'manual-comercial', { stance: 'contradicts', attrs: { attribute: 'precio_unitario' } });
de('GOVERNS', 'Crédito controlado por cliente', 'Bloqueo por límite de crédito excedido',
  'El bloqueo de pedidos aplica la política de crédito controlado.',
  'manual-administracion');
de('GOVERNS', 'Crédito controlado por cliente', 'Control de límite de crédito',
  'El recálculo periódico del riesgo desarrolla la política de crédito.',
  'manual-administracion');
de('GOVERNS', 'Retención documental', 'Cierre contable mensual',
  'El cierre archiva la documentación del mes conforme a los plazos de retención.',
  'manual-administracion');
de('EXECUTES', 'Contable', 'Cierre contable mensual',
  'El cierre mensual lo ejecuta el contable antes del día 10.',
  'manual-administracion');
de('EXECUTES', 'Contable', 'Emisión de abonos',
  'Los abonos los asienta el contable tras el visto bueno de administración.',
  'manual-administracion');
de('EXECUTES', 'Administración', 'Reclamación de impagos',
  'La reclamación de vencidos la lleva administración con tres avisos escalonados.',
  'manual-administracion');
de('TRIGGERS', 'Factura vencida', 'Reclamación de impagos',
  'El listado diario de vencidos arranca la reclamación de cada factura.',
  'manual-administracion');

const batch05 = {
  run_id: '2026-07-11T10-30-00-document-extended',
  source_type: 'document',
  schema_version: 1,
  extractor: { name: 'extractor-docs', model: 'claude-sonnet-5', prompt_version: 'docs-v1' },
  nodes: docNodes,
  edges: docEdges,
};

// ---------------------------------------------------------------------------
// Batch 06 — interview int-002 (jefe de producción)
// ---------------------------------------------------------------------------

const intNodes = [];
const intEdges = [];

function inn(type, mention, name, description, excerpt, validated) {
  const evidence = { locator: interviewLocator(), excerpt };
  if (validated) evidence.validated_by = 'produccion';
  intNodes.push({ mention, type, name, description, evidence });
}
function ine(type, source_mention, target_mention, excerpt, opts = {}) {
  const evidence = { locator: interviewLocator(), excerpt };
  if (opts.validated) evidence.validated_by = 'produccion';
  const edge = { type, source_mention, target_mention, evidence };
  if (opts.stance) edge.stance = opts.stance;
  intEdges.push(edge);
}

inn('entity', 'la troqueladora', 'Troqueladora',
  'Máquina de troquelado plano de la planta.',
  'La troqueladora es el cuello de botella de la planta: si para, para todo lo demás.', true);
inn('process', 'cambio de troquel', 'Cambio de troquel',
  'Sustitución y ajuste del troquel entre tiradas.',
  'En un cambio de troquel se nos van veinte minutos si todo está en su sitio; si falta el troquel, una hora.', true);
inn('process', 'mantenimiento preventivo', 'Mantenimiento preventivo',
  'Intervenciones planificadas de mantenimiento.',
  'El preventivo está muy bien sobre el papel; la realidad es que la máquina para cuando la producción lo permite.');
inn('rule', 'el FIFO de bobinas', 'FIFO de bobinas por antigüedad',
  'Consumo de bobinas por orden de entrada.',
  'Lo del FIFO va a misa: el SGA no te deja confirmar la tirada si coges una bobina más nueva.', true);
inn('rule', 'el muestreo de cinco cajas', 'Muestreo mínimo por tirada',
  'Control mínimo de cinco cajas por tirada.',
  'Las cinco cajas se sacan siempre: primera, última y tres del medio. Eso no se lo salta nadie.', true);
inn('rule', 'la parada de las 400 horas', 'Parada por horas de uso de troqueladora',
  'Parada preventiva por contador de horas.',
  'La parada de las 400 horas… digamos que el contador a veces "espera" a que acabe la campaña.');
inn('role', 'el técnico de mantenimiento', 'Técnico de mantenimiento',
  'Técnico que ejecuta preventivos y repara averías.',
  'El técnico firma todos los partes y sin su firma la máquina no arranca; en eso somos estrictos.', true);
inn('role', 'los operarios de troquelado', 'Operario de troquelado',
  'Operarios de la sección de troquelado.',
  'Cada operario lleva su máquina, hace sus cambios de troquel y saca sus muestras.', true);
inn('entity', 'no conformidades', 'No conformidad',
  'Registros de incumplimientos de calidad.',
  'Las no conformidades nos las tomamos en serio desde la auditoría de 2024: todo queda registrado.');
inn('process', 'el control de calidad de tirada', 'Control de calidad de tirada',
  'Inspección por muestreo de cada tirada.',
  'El control de tirada lo hace el propio operario y lo revisa calidad; sin ese registro la tirada no sale.', true);

ine('VALIDATES', 'el FIFO de bobinas', 'Troquelado',
  'Confirmo el FIFO: la tirada no arranca con una bobina que no sea la más antigua del gramaje. Lo veo cada día.',
  { validated: true });
ine('EXECUTES', 'el técnico de mantenimiento', 'mantenimiento preventivo',
  'Los preventivos los hace siempre el técnico de mantenimiento; los operarios solo engrasamos lo básico.',
  { validated: true });
ine('VALIDATES', 'la parada de las 400 horas', 'mantenimiento preventivo',
  'Se supone que a las 400 horas se para, pero llevamos meses estirándolo cuando hay campaña; el contador se "congela" y se para cuando se puede.',
  { stance: 'contradicts', validated: true });
ine('PART_OF', 'cambio de troquel', 'Troquelado',
  'El cambio de troquel es parte de la tirada: sin cambio hecho y primera caja validada no hay tirada.',
  { validated: true });
ine('VALIDATES', 'el muestreo de cinco cajas', 'el control de calidad de tirada',
  'El muestreo de las cinco cajas se cumple siempre; es lo primero que mira calidad en la auditoría.',
  { validated: true });
ine('EXECUTES', 'los operarios de troquelado', 'Troquelado',
  'Las tiradas las llevamos los operarios de troquelado, uno por máquina y turno.',
  { validated: true });
ine('VALIDATES', 'Prioridad de picking para urgentes', 'Picking de expedición',
  'Los urgentes pasan delante en el picking, eso se cumple a rajatabla porque lo fuerza el SGA.',
  { validated: true });
ine('VALIDATES', 'Descanso mínimo entre turnos', 'Cuadrante de turnos',
  'El cuadrante nunca te pone dos turnos sin las doce horas de descanso; RRHH lo tiene bloqueado en el sistema.',
  { validated: true });
ine('TRIGGERS', 'Tirada completada', 'Picking de expedición',
  'En cuanto cierro la tirada en el sistema, a los de almacén les aparece el picking del pedido.',
  { validated: true });
ine('VALIDATES', 'Bloqueo de tirada sin orden de fabricación', 'Troquelado',
  'Sin orden de fabricación aprobada la troqueladora ni se arranca; el sistema no te deja meter la tirada.',
  { validated: true });
ine('DEPENDS_ON', 'Troquelado', 'la troqueladora',
  'Todo el troquelado pasa por esa máquina; cuando ha estado averiada hemos tenido que subcontratar.',
  { validated: true });
ine('DEPENDS_ON', 'cambio de troquel', 'Troquel',
  'El cambio depende de que el troquel esté en su ubicación; si no aparece, la máquina espera.');
ine('TRIGGERS', 'No conformidad abierta', 'Gestión de no conformidades',
  'Cuando se abre una no conformidad nos llega el aviso y hay que buscar la causa; eso funciona desde 2024.',
  { validated: true });
ine('VALIDATES', 'Rechazo por delaminación', 'el control de calidad de tirada',
  'Si una caja delamina, la tirada se para y se revisa el lote entero; eso es sagrado.',
  { validated: true });

// Edge mentions that are not new nodes above must exist as batch nodes too.
inn('rule', 'Prioridad de picking para urgentes', 'Prioridad de picking para urgentes',
  'Los pedidos urgentes se preparan antes en picking.',
  'Los urgentes van delante en el almacén, igual que en máquina.', true);
inn('process', 'Picking de expedición', 'Picking de expedición',
  'Preparación de palets para carga.',
  'El picking se lo lanza el sistema a almacén en cuanto la tirada está cerrada.', true);
inn('rule', 'Descanso mínimo entre turnos', 'Descanso mínimo entre turnos',
  'Descanso mínimo de 12 horas entre turnos.',
  'Entre turno y turno tienes tus doce horas sí o sí.', true);
inn('process', 'Cuadrante de turnos', 'Cuadrante de turnos',
  'Asignación mensual de operarios a turnos.',
  'El cuadrante sale antes del 25 y ya sabes tu mes entero.', true);
inn('event', 'Tirada completada', 'Tirada completada',
  'Fin de una tirada con su recuento.',
  'Cierro la tirada con las cajas buenas y la merma, y ahí acaba lo mío.', true);
inn('rule', 'Bloqueo de tirada sin orden de fabricación', 'Bloqueo de tirada sin orden de fabricación',
  'No hay tirada sin orden de fabricación aprobada.',
  'Sin orden aprobada no hay tirada, eso el sistema lo bloquea.', true);
inn('process', 'Troquelado', 'Troquelado',
  'Tiradas de corte con troquel.',
  'El troquelado es lo nuestro: cambio, tirada, muestras y cierre.', true);
inn('entity', 'Troquel', 'Troquel',
  'Herramienta de corte de cada trabajo.',
  'Cada trabajo tiene su troquel y cada troquel su ubicación en el almacén de troqueles.', true);
inn('event', 'No conformidad abierta', 'No conformidad abierta',
  'Apertura de una no conformidad.',
  'El aviso de la no conformidad te llega al momento, con su número y su tirada.', true);
inn('process', 'Gestión de no conformidades', 'Gestión de no conformidades',
  'Ciclo de análisis y cierre de no conformidades.',
  'Lo de las no conformidades va con plazos: causa, acción y cierre firmado por calidad.', true);
inn('rule', 'Rechazo por delaminación', 'Rechazo por delaminación',
  'Rechazo de unidades con delaminación.',
  'Caja que delamina, caja que se aparta; y si hay varias, se para la tirada.', true);

const batch06 = {
  run_id: '2026-07-12T11-00-00-interview-produccion',
  source_type: 'interview',
  schema_version: 1,
  extractor: { name: 'extractor-interview', model: 'claude-sonnet-5', prompt_version: 'interview-v1' },
  nodes: intNodes,
  edges: intEdges,
};

// ---------------------------------------------------------------------------

const files = {
  '04-code-extended.json': batch04,
  '05-docs-extended.json': batch05,
  '06-interview-produccion.json': batch06,
};
for (const [name, batch] of Object.entries(files)) {
  writeFileSync(join(outDir, name), `${JSON.stringify(batch, null, 2)}\n`, 'utf8');
  console.log(`${name}: ${batch.nodes.length} nodes, ${batch.edges.length} edges`);
}
