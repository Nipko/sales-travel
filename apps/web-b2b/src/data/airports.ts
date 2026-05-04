export interface Airport {
  code: string;
  name: string;
  city: string;
  country: string;
  countryCode: string;
  flag: string;
  lat: number;
  lng: number;
  popular?: boolean;
  keywords?: string[];
}

export const AIRPORTS: Airport[] = [
  // ── Colombia ────────────────────────────────────────
  { code: 'BOG', name: 'El Dorado International', city: 'Bogotá', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 4.7016, lng: -74.1469, popular: true, keywords: ['bogota', 'eldorado'] },
  { code: 'MDE', name: 'José María Córdova International', city: 'Medellín', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 6.1645, lng: -75.4231, popular: true, keywords: ['medellin', 'rionegro'] },
  { code: 'CLO', name: 'Alfonso Bonilla Aragón International', city: 'Cali', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 3.5432, lng: -76.3816, popular: true, keywords: ['palmira'] },
  { code: 'CTG', name: 'Rafael Núñez International', city: 'Cartagena', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 10.4424, lng: -75.513, popular: true, keywords: ['cartagena de indias'] },
  { code: 'BAQ', name: 'Ernesto Cortissoz International', city: 'Barranquilla', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 10.8896, lng: -74.7808 },
  { code: 'SMR', name: 'Simón Bolívar International', city: 'Santa Marta', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 11.1196, lng: -74.2306 },
  { code: 'ADZ', name: 'Gustavo Rojas Pinilla International', city: 'San Andrés', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 12.5836, lng: -81.7112, keywords: ['san andres isla'] },
  { code: 'PEI', name: 'Matecaña International', city: 'Pereira', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 4.8127, lng: -75.7395 },
  { code: 'BGA', name: 'Palonegro International', city: 'Bucaramanga', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 7.1265, lng: -73.1848 },
  { code: 'EOH', name: 'Olaya Herrera', city: 'Medellín', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 6.2205, lng: -75.5906, keywords: ['enrique olaya herrera', 'medellin centro'] },
  { code: 'AXM', name: 'El Edén International', city: 'Armenia', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 4.4528, lng: -75.7664, keywords: ['eje cafetero'] },
  { code: 'LET', name: 'Alfredo Vásquez Cobo International', city: 'Leticia', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: -4.1935, lng: -69.9432, keywords: ['amazonas'] },
  { code: 'VUP', name: 'Alfonso López Pumarejo', city: 'Valledupar', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 10.435, lng: -73.2495 },
  { code: 'MTR', name: 'Los Garzones', city: 'Montería', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 8.8237, lng: -75.8258 },
  { code: 'CUC', name: 'Camilo Daza International', city: 'Cúcuta', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 7.9275, lng: -72.5115, keywords: ['cucuta'] },
  { code: 'NVA', name: 'Benito Salas', city: 'Neiva', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 2.95, lng: -75.294 },
  { code: 'MZL', name: 'La Nubia', city: 'Manizales', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 5.0296, lng: -75.4647 },
  { code: 'TCO', name: 'La Florida', city: 'Tumaco', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 1.8145, lng: -78.7493 },
  { code: 'UIB', name: 'El Caraño', city: 'Quibdó', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 5.6908, lng: -76.6413, keywords: ['choco'] },
  { code: 'RCH', name: 'Almirante Padilla', city: 'Riohacha', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 11.5262, lng: -72.926, keywords: ['guajira'] },
  { code: 'FLA', name: 'Gustavo Artunduaga Paredes', city: 'Florencia', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 1.5893, lng: -75.5644, keywords: ['caqueta'] },
  { code: 'PSO', name: 'Antonio Nariño', city: 'Pasto', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 1.3962, lng: -77.2915, keywords: ['ipiales', 'narino'] },
  { code: 'IBE', name: 'Perales', city: 'Ibagué', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 4.4216, lng: -75.1334, keywords: ['tolima'] },
  { code: 'APO', name: 'Antonio Roldán Betancourt', city: 'Apartadó', country: 'Colombia', countryCode: 'CO', flag: '🇨🇴', lat: 7.882, lng: -76.7164, keywords: ['uraba'] },

  // ── Perú ────────────────────────────────────────────
  { code: 'LIM', name: 'Jorge Chávez International', city: 'Lima', country: 'Perú', countryCode: 'PE', flag: '🇵🇪', lat: -12.0219, lng: -77.1143, popular: true, keywords: ['callao'] },
  { code: 'CUZ', name: 'Alejandro Velasco Astete International', city: 'Cusco', country: 'Perú', countryCode: 'PE', flag: '🇵🇪', lat: -13.5357, lng: -71.9388, popular: true, keywords: ['cuzco', 'machu picchu'] },
  { code: 'AQP', name: 'Rodríguez Ballón International', city: 'Arequipa', country: 'Perú', countryCode: 'PE', flag: '🇵🇪', lat: -16.3411, lng: -71.5831 },
  { code: 'TRU', name: 'Carlos Martínez de Pinillos International', city: 'Trujillo', country: 'Perú', countryCode: 'PE', flag: '🇵🇪', lat: -8.0814, lng: -79.1088 },
  { code: 'PIU', name: 'Capitán FAP Guillermo Concha Iberico International', city: 'Piura', country: 'Perú', countryCode: 'PE', flag: '🇵🇪', lat: -5.2056, lng: -80.6164 },
  { code: 'IQT', name: 'Coronel FAP Francisco Secada Vignetta International', city: 'Iquitos', country: 'Perú', countryCode: 'PE', flag: '🇵🇪', lat: -3.7847, lng: -73.3088, keywords: ['amazonas peru'] },
  { code: 'JUL', name: 'Inca Manco Cápac International', city: 'Juliaca', country: 'Perú', countryCode: 'PE', flag: '🇵🇪', lat: -15.4671, lng: -70.1582, keywords: ['puno', 'titicaca'] },
  { code: 'TCQ', name: 'Coronel FAP Carlos Ciriani Santa Rosa International', city: 'Tacna', country: 'Perú', countryCode: 'PE', flag: '🇵🇪', lat: -18.0533, lng: -70.2756 },
  { code: 'PCL', name: 'Capitán FAP David Abensur Rengifo International', city: 'Pucallpa', country: 'Perú', countryCode: 'PE', flag: '🇵🇪', lat: -8.3779, lng: -74.5743 },
  { code: 'CJA', name: 'Mayor General FAP Armando Revoredo Iglesias', city: 'Cajamarca', country: 'Perú', countryCode: 'PE', flag: '🇵🇪', lat: -7.1319, lng: -78.4894 },
  { code: 'TPP', name: 'Cadete FAP Guillermo del Castillo Paredes', city: 'Tarapoto', country: 'Perú', countryCode: 'PE', flag: '🇵🇪', lat: -6.5089, lng: -76.3732 },
  { code: 'AYP', name: 'Coronel FAP Alfredo Mendívil Duarte', city: 'Ayacucho', country: 'Perú', countryCode: 'PE', flag: '🇵🇪', lat: -13.1549, lng: -74.2044 },
  { code: 'CHM', name: 'Teniente FAP Jaime Montreuil Morales', city: 'Chimbote', country: 'Perú', countryCode: 'PE', flag: '🇵🇪', lat: -9.1498, lng: -78.5238 },

  // ── Brasil ──────────────────────────────────────────
  { code: 'GRU', name: 'Guarulhos – Governador André Franco Montoro International', city: 'São Paulo', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -23.4356, lng: -46.4731, popular: true, keywords: ['sao paulo', 'guarulhos', 'cumbica'] },
  { code: 'GIG', name: 'Galeão – Antônio Carlos Jobim International', city: 'Río de Janeiro', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -22.8099, lng: -43.2506, popular: true, keywords: ['rio de janeiro', 'galeao'] },
  { code: 'BSB', name: 'Presidente Juscelino Kubitschek International', city: 'Brasília', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -15.8711, lng: -47.9186 },
  { code: 'CNF', name: 'Tancredo Neves International', city: 'Belo Horizonte', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -19.6244, lng: -43.9719, keywords: ['confins'] },
  { code: 'SSA', name: 'Deputado Luís Eduardo Magalhães International', city: 'Salvador', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -12.9111, lng: -38.3311, keywords: ['bahia'] },
  { code: 'REC', name: 'Guararapes – Gilberto Freyre International', city: 'Recife', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -8.1265, lng: -34.9235 },
  { code: 'FOR', name: 'Pinto Martins International', city: 'Fortaleza', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -3.7763, lng: -38.5326 },
  { code: 'CWB', name: 'Afonso Pena International', city: 'Curitiba', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -25.5285, lng: -49.1758 },
  { code: 'POA', name: 'Salgado Filho International', city: 'Porto Alegre', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -29.9944, lng: -51.1714 },
  { code: 'CGH', name: 'Congonhas', city: 'São Paulo', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -23.6261, lng: -46.6564, keywords: ['sao paulo congonhas', 'domestico'] },
  { code: 'SDU', name: 'Santos Dumont', city: 'Río de Janeiro', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -22.9104, lng: -43.1631, keywords: ['rio santos dumont', 'domestico'] },
  { code: 'VCP', name: 'Viracopos International', city: 'Campinas', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -23.0074, lng: -47.1345, keywords: ['sao paulo viracopos'] },
  { code: 'BEL', name: 'Val de Cans International', city: 'Belém', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -1.3794, lng: -48.4764, keywords: ['para'] },
  { code: 'MCZ', name: 'Zumbi dos Palmares International', city: 'Maceió', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -9.5108, lng: -35.7917 },
  { code: 'NAT', name: 'São Gonçalo do Amarante International', city: 'Natal', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -5.7681, lng: -35.3764 },
  { code: 'MAO', name: 'Eduardo Gomes International', city: 'Manaos', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -3.0386, lng: -60.0497, keywords: ['manaus', 'amazonas'] },
  { code: 'FLN', name: 'Hercílio Luz International', city: 'Florianópolis', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -27.6703, lng: -48.5525 },
  { code: 'GYN', name: 'Santa Genoveva', city: 'Goiânia', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -16.632, lng: -49.2207 },
  { code: 'SLZ', name: 'Marechal Cunha Machado International', city: 'São Luís', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -2.5853, lng: -44.2341 },
  { code: 'CGB', name: 'Marechal Rondon International', city: 'Cuiabá', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -15.6529, lng: -56.1167 },
  { code: 'VIX', name: 'Eurico de Aguiar Salles', city: 'Vitória', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -20.2581, lng: -40.2864 },
  { code: 'AJU', name: 'Santa Maria', city: 'Aracaju', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -10.984, lng: -37.0703 },
  { code: 'THE', name: 'Senador Petrônio Portella', city: 'Teresina', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -5.0599, lng: -42.8235 },
  { code: 'JPA', name: 'Presidente Castro Pinto International', city: 'João Pessoa', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -7.1482, lng: -34.9508 },
  { code: 'CGR', name: 'Campo Grande International', city: 'Campo Grande', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -20.4687, lng: -54.6726 },
  { code: 'IGU', name: 'Foz do Iguaçu International', city: 'Foz do Iguaçu', country: 'Brasil', countryCode: 'BR', flag: '🇧🇷', lat: -25.5962, lng: -54.4871, keywords: ['iguazu cataratas'] },

  // ── Chile ───────────────────────────────────────────
  { code: 'SCL', name: 'Arturo Merino Benítez International', city: 'Santiago', country: 'Chile', countryCode: 'CL', flag: '🇨🇱', lat: -33.393, lng: -70.7858, popular: true },
  { code: 'IQQ', name: 'Diego Aracena International', city: 'Iquique', country: 'Chile', countryCode: 'CL', flag: '🇨🇱', lat: -20.5353, lng: -70.1813 },
  { code: 'ANF', name: 'Andrés Sabella Gálvez International', city: 'Antofagasta', country: 'Chile', countryCode: 'CL', flag: '🇨🇱', lat: -23.4445, lng: -70.4451 },
  { code: 'CCP', name: 'Carriel Sur International', city: 'Concepción', country: 'Chile', countryCode: 'CL', flag: '🇨🇱', lat: -36.7727, lng: -73.0631 },
  { code: 'PMC', name: 'El Tepual International', city: 'Puerto Montt', country: 'Chile', countryCode: 'CL', flag: '🇨🇱', lat: -41.4389, lng: -73.094 },
  { code: 'PUQ', name: 'Carlos Ibáñez del Campo International', city: 'Punta Arenas', country: 'Chile', countryCode: 'CL', flag: '🇨🇱', lat: -53.0026, lng: -70.8546, keywords: ['patagonia'] },
  { code: 'IPC', name: 'Mataveri International', city: 'Isla de Pascua', country: 'Chile', countryCode: 'CL', flag: '🇨🇱', lat: -27.1648, lng: -109.4219, keywords: ['easter island', 'rapa nui'] },

  // ── Argentina ───────────────────────────────────────
  { code: 'EZE', name: 'Ministro Pistarini International', city: 'Buenos Aires', country: 'Argentina', countryCode: 'AR', flag: '🇦🇷', lat: -34.8222, lng: -58.5358, popular: true, keywords: ['ezeiza'] },
  { code: 'AEP', name: 'Aeroparque Jorge Newbery', city: 'Buenos Aires', country: 'Argentina', countryCode: 'AR', flag: '🇦🇷', lat: -34.5592, lng: -58.4156, keywords: ['aeroparque', 'domestico'] },
  { code: 'COR', name: 'Ingeniero Ambrosio Taravella International', city: 'Córdoba', country: 'Argentina', countryCode: 'AR', flag: '🇦🇷', lat: -31.3236, lng: -64.208, keywords: ['pajas blancas'] },
  { code: 'MDZ', name: 'El Plumerillo International', city: 'Mendoza', country: 'Argentina', countryCode: 'AR', flag: '🇦🇷', lat: -32.8317, lng: -68.793 },
  { code: 'BRC', name: 'Teniente Luis Candelaria International', city: 'Bariloche', country: 'Argentina', countryCode: 'AR', flag: '🇦🇷', lat: -41.1512, lng: -71.1575, keywords: ['san carlos de bariloche', 'patagonia'] },
  { code: 'IGR', name: 'Cataratas del Iguazú International', city: 'Puerto Iguazú', country: 'Argentina', countryCode: 'AR', flag: '🇦🇷', lat: -25.7373, lng: -54.4734, keywords: ['iguazu', 'cataratas'] },
  { code: 'USH', name: 'Malvinas Argentinas International', city: 'Ushuaia', country: 'Argentina', countryCode: 'AR', flag: '🇦🇷', lat: -54.8433, lng: -68.2958, keywords: ['fin del mundo', 'tierra del fuego'] },
  { code: 'ROS', name: 'Islas Malvinas International', city: 'Rosario', country: 'Argentina', countryCode: 'AR', flag: '🇦🇷', lat: -32.9036, lng: -60.785 },
  { code: 'SLA', name: 'Martín Miguel de Güemes International', city: 'Salta', country: 'Argentina', countryCode: 'AR', flag: '🇦🇷', lat: -24.856, lng: -65.4862 },
  { code: 'TUC', name: 'Teniente Benjamín Matienzo International', city: 'Tucumán', country: 'Argentina', countryCode: 'AR', flag: '🇦🇷', lat: -26.8409, lng: -65.1049, keywords: ['san miguel de tucuman'] },
  { code: 'NQN', name: 'Presidente Perón International', city: 'Neuquén', country: 'Argentina', countryCode: 'AR', flag: '🇦🇷', lat: -38.949, lng: -68.1557 },
  { code: 'FTE', name: 'Comandante Armando Tola International', city: 'El Calafate', country: 'Argentina', countryCode: 'AR', flag: '🇦🇷', lat: -50.2803, lng: -72.0531, keywords: ['glaciar perito moreno', 'patagonia'] },

  // ── Ecuador ─────────────────────────────────────────
  { code: 'UIO', name: 'Mariscal Sucre International', city: 'Quito', country: 'Ecuador', countryCode: 'EC', flag: '🇪🇨', lat: -0.1292, lng: -78.3575, popular: true },
  { code: 'GYE', name: 'José Joaquín de Olmedo International', city: 'Guayaquil', country: 'Ecuador', countryCode: 'EC', flag: '🇪🇨', lat: -2.1574, lng: -79.8837 },
  { code: 'GPS', name: 'Seymour', city: 'Islas Galápagos', country: 'Ecuador', countryCode: 'EC', flag: '🇪🇨', lat: -0.4537, lng: -90.2659, keywords: ['galapagos', 'baltra'] },
  { code: 'CUE', name: 'Mariscal Lamar', city: 'Cuenca', country: 'Ecuador', countryCode: 'EC', flag: '🇪🇨', lat: -2.8894, lng: -78.9844 },

  // ── Bolivia ─────────────────────────────────────────
  { code: 'VVI', name: 'Viru Viru International', city: 'Santa Cruz', country: 'Bolivia', countryCode: 'BO', flag: '🇧🇴', lat: -17.6448, lng: -63.1354 },
  { code: 'LPB', name: 'El Alto International', city: 'La Paz', country: 'Bolivia', countryCode: 'BO', flag: '🇧🇴', lat: -16.5133, lng: -68.1923 },
  { code: 'CBB', name: 'Jorge Wilstermann International', city: 'Cochabamba', country: 'Bolivia', countryCode: 'BO', flag: '🇧🇴', lat: -17.4211, lng: -66.1771 },

  // ── Paraguay ────────────────────────────────────────
  { code: 'ASU', name: 'Silvio Pettirossi International', city: 'Asunción', country: 'Paraguay', countryCode: 'PY', flag: '🇵🇾', lat: -25.24, lng: -57.519 },

  // ── Uruguay ─────────────────────────────────────────
  { code: 'MVD', name: 'Carrasco International', city: 'Montevideo', country: 'Uruguay', countryCode: 'UY', flag: '🇺🇾', lat: -34.8384, lng: -56.0308 },
  { code: 'PDP', name: 'Capitán de Corbeta Carlos A. Curbelo International', city: 'Punta del Este', country: 'Uruguay', countryCode: 'UY', flag: '🇺🇾', lat: -34.8559, lng: -55.0943 },

  // ── Venezuela ───────────────────────────────────────
  { code: 'CCS', name: 'Simón Bolívar International', city: 'Caracas', country: 'Venezuela', countryCode: 'VE', flag: '🇻🇪', lat: 10.6012, lng: -66.9912, keywords: ['maiquetia'] },

  // ── Panamá ──────────────────────────────────────────
  { code: 'PTY', name: 'Tocumen International', city: 'Ciudad de Panamá', country: 'Panamá', countryCode: 'PA', flag: '🇵🇦', lat: 9.0714, lng: -79.3835, popular: true, keywords: ['panama city', 'hub copa'] },

  // ── México ──────────────────────────────────────────
  { code: 'MEX', name: 'Benito Juárez International', city: 'Ciudad de México', country: 'México', countryCode: 'MX', flag: '🇲🇽', lat: 19.4363, lng: -99.0721, popular: true, keywords: ['mexico city', 'cdmx'] },
  { code: 'CUN', name: 'Cancún International', city: 'Cancún', country: 'México', countryCode: 'MX', flag: '🇲🇽', lat: 21.0365, lng: -86.8771, popular: true, keywords: ['riviera maya'] },
  { code: 'GDL', name: 'Miguel Hidalgo y Costilla International', city: 'Guadalajara', country: 'México', countryCode: 'MX', flag: '🇲🇽', lat: 20.5218, lng: -103.3111 },
  { code: 'MTY', name: 'General Mariano Escobedo International', city: 'Monterrey', country: 'México', countryCode: 'MX', flag: '🇲🇽', lat: 25.7785, lng: -100.107 },
  { code: 'SJD', name: 'Los Cabos International', city: 'San José del Cabo', country: 'México', countryCode: 'MX', flag: '🇲🇽', lat: 23.1518, lng: -109.7215, keywords: ['cabo san lucas'] },
  { code: 'PVR', name: 'Licenciado Gustavo Díaz Ordaz International', city: 'Puerto Vallarta', country: 'México', countryCode: 'MX', flag: '🇲🇽', lat: 20.6801, lng: -105.2543 },
  { code: 'TIJ', name: 'General Abelardo L. Rodríguez International', city: 'Tijuana', country: 'México', countryCode: 'MX', flag: '🇲🇽', lat: 32.5411, lng: -116.9701 },

  // ── Centroamérica y Caribe ──────────────────────────
  { code: 'SJO', name: 'Juan Santamaría International', city: 'San José', country: 'Costa Rica', countryCode: 'CR', flag: '🇨🇷', lat: 9.9939, lng: -84.2088 },
  { code: 'SAL', name: 'Monseñor Óscar Arnulfo Romero International', city: 'San Salvador', country: 'El Salvador', countryCode: 'SV', flag: '🇸🇻', lat: 13.4409, lng: -89.0557 },
  { code: 'GUA', name: 'La Aurora International', city: 'Guatemala City', country: 'Guatemala', countryCode: 'GT', flag: '🇬🇹', lat: 14.5833, lng: -90.5275 },
  { code: 'SDQ', name: 'Las Américas International', city: 'Santo Domingo', country: 'Rep. Dominicana', countryCode: 'DO', flag: '🇩🇴', lat: 18.4297, lng: -69.6689 },
  { code: 'PUJ', name: 'Punta Cana International', city: 'Punta Cana', country: 'Rep. Dominicana', countryCode: 'DO', flag: '🇩🇴', lat: 18.5674, lng: -68.3634, popular: true },
  { code: 'HAV', name: 'José Martí International', city: 'La Habana', country: 'Cuba', countryCode: 'CU', flag: '🇨🇺', lat: 22.9892, lng: -82.4091 },
  { code: 'MBJ', name: 'Sangster International', city: 'Montego Bay', country: 'Jamaica', countryCode: 'JM', flag: '🇯🇲', lat: 18.5037, lng: -77.9134 },
  { code: 'AUA', name: 'Queen Beatrix International', city: 'Oranjestad', country: 'Aruba', countryCode: 'AW', flag: '🇦🇼', lat: 12.5014, lng: -70.0152 },
  { code: 'CUR', name: 'Hato International', city: 'Willemstad', country: 'Curaçao', countryCode: 'CW', flag: '🇨🇼', lat: 12.1889, lng: -68.9598, keywords: ['curacao'] },
  { code: 'TGU', name: 'Toncontín International', city: 'Tegucigalpa', country: 'Honduras', countryCode: 'HN', flag: '🇭🇳', lat: 14.0609, lng: -87.2172 },
  { code: 'MGA', name: 'Augusto C. Sandino International', city: 'Managua', country: 'Nicaragua', countryCode: 'NI', flag: '🇳🇮', lat: 12.1415, lng: -86.1682 },

  // ── Estados Unidos (hubs de conexión LATAM) ─────────
  { code: 'MIA', name: 'Miami International', city: 'Miami', country: 'Estados Unidos', countryCode: 'US', flag: '🇺🇸', lat: 25.7959, lng: -80.287, popular: true, keywords: ['florida'] },
  { code: 'JFK', name: 'John F. Kennedy International', city: 'Nueva York', country: 'Estados Unidos', countryCode: 'US', flag: '🇺🇸', lat: 40.6413, lng: -73.7781, popular: true, keywords: ['new york'] },
  { code: 'EWR', name: 'Newark Liberty International', city: 'Newark', country: 'Estados Unidos', countryCode: 'US', flag: '🇺🇸', lat: 40.6895, lng: -74.1745, keywords: ['new york newark', 'nueva york'] },
  { code: 'LAX', name: 'Los Angeles International', city: 'Los Ángeles', country: 'Estados Unidos', countryCode: 'US', flag: '🇺🇸', lat: 33.9416, lng: -118.4085 },
  { code: 'ORD', name: "O'Hare International", city: 'Chicago', country: 'Estados Unidos', countryCode: 'US', flag: '🇺🇸', lat: 41.9742, lng: -87.9073 },
  { code: 'DFW', name: 'Dallas/Fort Worth International', city: 'Dallas', country: 'Estados Unidos', countryCode: 'US', flag: '🇺🇸', lat: 32.8998, lng: -97.0403 },
  { code: 'ATL', name: 'Hartsfield-Jackson International', city: 'Atlanta', country: 'Estados Unidos', countryCode: 'US', flag: '🇺🇸', lat: 33.6407, lng: -84.4277 },
  { code: 'IAH', name: 'George Bush Intercontinental', city: 'Houston', country: 'Estados Unidos', countryCode: 'US', flag: '🇺🇸', lat: 29.9844, lng: -95.3414, keywords: ['united hub'] },
  { code: 'FLL', name: 'Fort Lauderdale-Hollywood International', city: 'Fort Lauderdale', country: 'Estados Unidos', countryCode: 'US', flag: '🇺🇸', lat: 26.0726, lng: -80.1527, keywords: ['florida'] },
  { code: 'MCO', name: 'Orlando International', city: 'Orlando', country: 'Estados Unidos', countryCode: 'US', flag: '🇺🇸', lat: 28.4312, lng: -81.308, keywords: ['disney', 'florida'] },
  { code: 'SFO', name: 'San Francisco International', city: 'San Francisco', country: 'Estados Unidos', countryCode: 'US', flag: '🇺🇸', lat: 37.6213, lng: -122.379 },

  // ── Europa (hubs de conexión) ───────────────────────
  { code: 'MAD', name: 'Adolfo Suárez Madrid-Barajas', city: 'Madrid', country: 'España', countryCode: 'ES', flag: '🇪🇸', lat: 40.4719, lng: -3.5626, popular: true, keywords: ['barajas', 'iberia hub'] },
  { code: 'BCN', name: 'Josep Tarradellas Barcelona-El Prat', city: 'Barcelona', country: 'España', countryCode: 'ES', flag: '🇪🇸', lat: 41.2971, lng: 2.0785, keywords: ['el prat'] },
  { code: 'LIS', name: 'Humberto Delgado', city: 'Lisboa', country: 'Portugal', countryCode: 'PT', flag: '🇵🇹', lat: 38.7756, lng: -9.1354, keywords: ['tap hub', 'lisbon'] },
  { code: 'CDG', name: 'Charles de Gaulle', city: 'París', country: 'Francia', countryCode: 'FR', flag: '🇫🇷', lat: 49.0097, lng: 2.5479, keywords: ['paris', 'air france hub'] },
  { code: 'LHR', name: 'Heathrow', city: 'Londres', country: 'Reino Unido', countryCode: 'GB', flag: '🇬🇧', lat: 51.47, lng: -0.4543, keywords: ['london'] },
  { code: 'AMS', name: 'Schiphol', city: 'Ámsterdam', country: 'Países Bajos', countryCode: 'NL', flag: '🇳🇱', lat: 52.3105, lng: 4.7683, keywords: ['amsterdam', 'klm hub'] },
  { code: 'FRA', name: 'Frankfurt am Main', city: 'Frankfurt', country: 'Alemania', countryCode: 'DE', flag: '🇩🇪', lat: 50.0379, lng: 8.5622, keywords: ['lufthansa hub'] },
  { code: 'FCO', name: 'Leonardo da Vinci–Fiumicino', city: 'Roma', country: 'Italia', countryCode: 'IT', flag: '🇮🇹', lat: 41.8003, lng: 12.2389, keywords: ['rome', 'roma'] },
  { code: 'IST', name: 'İstanbul Airport', city: 'Estambul', country: 'Turquía', countryCode: 'TR', flag: '🇹🇷', lat: 41.2753, lng: 28.7519, keywords: ['istanbul', 'turkish hub'] },

  // ── Medio Oriente (hubs) ────────────────────────────
  { code: 'DXB', name: 'Dubai International', city: 'Dubái', country: 'Emiratos Árabes', countryCode: 'AE', flag: '🇦🇪', lat: 25.2532, lng: 55.3657, keywords: ['dubai', 'emirates hub'] },
  { code: 'DOH', name: 'Hamad International', city: 'Doha', country: 'Catar', countryCode: 'QA', flag: '🇶🇦', lat: 25.2731, lng: 51.6081, keywords: ['qatar hub'] },
];
