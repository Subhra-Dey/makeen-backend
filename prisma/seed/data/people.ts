import type { StandardRole } from '../../../src/shared';

export interface PersonSeed {
  code: string;
  name: string;
  /** 10-digit KEKA mobile. Mockup people keep the masked prefix/suffix shown in the mockup. */
  phone: string;
  /** Fake 12-digit Aadhaar (starts with 1 — never a real Aadhaar). Last 4 as in the mockup. */
  aadhaar: string;
  designation: string;
  role: StandardRole | null;
  /** Plant codes, or 'ALL'. */
  plants: readonly string[] | 'ALL';
  login: 'ACTIVE' | 'INACTIVE';
  working?: 'WORKING' | 'RESIGNED';
  /** Authored "yyyy-mm-dd HH:mm" IST, or null for never. */
  lastLogin: string | null;
}

const SOUTH = [
  'HPY-011',
  'BPC-005',
  'CPC-002',
  'BPD-014',
  'HPW-023',
  'IOJ-026',
  'IOT-030',
  'ION-028',
];

/** Named people from the mockup (spec §9). */
export const MOCKUP_PEOPLE: readonly PersonSeed[] = [
  {
    code: 'MEI-00412',
    name: 'Anita Sharma',
    phone: '9812345621',
    aadhaar: '123456784821',
    designation: 'Manager — Facility Systems',
    role: 'Admin',
    plants: 'ALL',
    login: 'ACTIVE',
    lastLogin: '2026-10-16 08:02',
  },
  {
    code: 'MEI-00218',
    name: 'Ravi Kumar',
    phone: '9945612310',
    aadhaar: '123498767731',
    designation: 'Plant Manager',
    role: 'Plant Manager',
    plants: ['HPY-011'],
    login: 'ACTIVE',
    lastLogin: '2026-10-16 09:40',
  },
  {
    code: 'MEI-00733',
    name: 'Asha Nair',
    phone: '9876543245',
    aadhaar: '187654321102',
    designation: 'Maintenance Officer',
    role: 'Maintenance Officer',
    plants: ['HPY-011', 'HPB-017'],
    login: 'ACTIVE',
    lastLogin: '2026-10-16 07:58',
  },
  {
    code: 'MEI-00901',
    name: 'Rahul Verma',
    phone: '9765432188',
    aadhaar: '176543213390',
    designation: 'Safety Officer',
    role: 'Safety Officer',
    plants: ['IOW-025'],
    login: 'ACTIVE',
    lastLogin: '2026-10-16 08:30',
  },
  {
    code: 'MEI-00455',
    name: 'Deepak Sahu',
    phone: '9443218762',
    aadhaar: '154321098045',
    designation: 'Sr. O&M Officer',
    role: 'Sr. Operations and Maintenance Officer',
    plants: ['IOK-021'],
    login: 'ACTIVE',
    lastLogin: '2026-10-15 19:20',
  },
  {
    code: 'MEI-00120',
    name: 'Meera Iyer',
    phone: '9822100407',
    aadhaar: '132109875512',
    designation: 'Zonal Manager — South',
    role: 'Zonal Manager',
    plants: SOUTH,
    login: 'ACTIVE',
    lastLogin: '2026-10-15 18:12',
  },
  {
    code: 'MEI-00611',
    name: 'Manoj Singh',
    phone: '9311204519',
    aadhaar: '143210986650',
    designation: 'Operation Officer',
    role: 'Operation Officer',
    plants: ['HPB-017'],
    login: 'INACTIVE',
    working: 'RESIGNED',
    lastLogin: '2026-09-30 21:04',
  },
  {
    code: 'MEI-01022',
    name: 'Sanjay Ghosh',
    phone: '9012345633',
    aadhaar: '165432102208',
    designation: 'Trainee Engineer',
    role: null,
    plants: [],
    login: 'INACTIVE',
    lastLogin: null,
  },
  {
    code: 'MEI-00742',
    name: 'Kiran Patel',
    phone: '9898123456',
    aadhaar: '112233445566',
    designation: 'Operation Officer',
    role: 'Operation Officer',
    plants: ['BPS-004'],
    login: 'ACTIVE',
    lastLogin: '2026-10-16 08:15',
  },
  {
    code: 'MEI-00756',
    name: 'S. Karthik',
    phone: '9884012345',
    aadhaar: '122334455667',
    designation: 'Maintenance Officer',
    role: 'Maintenance Officer',
    plants: ['CPC-002'],
    login: 'ACTIVE',
    lastLogin: '2026-10-16 07:40',
  },
];

/** Plant Managers (employee code matches plants.ts `manager`). Ravi Kumar manages Yediyur above. */
const PLANT_MANAGERS: readonly [string, string, string][] = [
  ['MEI-00301', 'Vikram Rathore', 'BLT-001'],
  ['MEI-00302', 'Sunita Mishra', 'BPB-007'],
  ['MEI-00303', 'Arvind Saxena', 'BPR-009'],
  ['MEI-00304', 'Pankaj Mahato', 'BPK-012'],
  ['MEI-00305', 'Lakshmi Narayanan', 'BPC-005'],
  ['MEI-00306', 'Girish Kulkarni', 'BPD-014'],
  ['MEI-00307', 'Priyanka Rao', 'BPS-004'],
  ['MEI-00308', 'Senthil Murugan', 'CPC-002'],
  ['MEI-00309', 'Ajay Tiwari', 'HPB-017'],
  ['MEI-00310', 'Mahendra Choudhary', 'HPR-018'],
  ['MEI-00311', 'Ranjit Kumar', 'HPM-019'],
  ['MEI-00312', 'Sachin Wankhede', 'HPC-020'],
  ['MEI-00313', 'Bhaskar Bora', 'HPG-022'],
  ['MEI-00314', 'Srinivas Reddy', 'HPW-023'],
  ['MEI-00315', 'Alok Srivastava', 'IOG-024'],
  ['MEI-00316', 'Rakesh Jain', 'IOW-025'],
  ['MEI-00317', 'Thomas Mathew', 'IOJ-026'],
  ['MEI-00318', 'Naveen Sinha', 'IOK-021'],
  ['MEI-00319', 'Sanjeev Jha', 'IOM-027'],
  ['MEI-00320', 'Ashwin Deshmukh', 'ION-028'],
  ['MEI-00321', 'Karthikeyan S', 'IOT-030'],
];

/** One entry officer per remaining working plant (mockup plants already have their people). */
const ENTRY_OFFICERS: readonly [string, string, StandardRole, string][] = [
  ['MEI-01101', 'Rohit Meena', 'Operation Officer', 'BLT-001'],
  ['MEI-01102', 'Subhashree Panda', 'Maintenance Officer', 'BPB-007'],
  ['MEI-01103', 'Ankit Yadav', 'Operation Officer', 'BPR-009'],
  ['MEI-01104', 'Sweta Kumari', 'Maintenance Officer', 'BPK-012'],
  ['MEI-01105', 'Arun Prakash', 'Sr. Operations and Maintenance Officer', 'BPC-005'],
  ['MEI-01106', 'Mahesh Patil', 'Operation Officer', 'BPD-014'],
  ['MEI-01107', 'Ramesh Gehlot', 'Maintenance Officer', 'HPR-018'],
  ['MEI-01108', 'Neha Kumari', 'Operation Officer', 'HPM-019'],
  ['MEI-01109', 'Prashant Bhoyar', 'Dy Plant Incharge', 'HPC-020'],
  ['MEI-01110', 'Dipankar Das', 'Maintenance Officer', 'HPG-022'],
  ['MEI-01111', 'Kavitha Rao', 'Operation Officer', 'HPW-023'],
  ['MEI-01112', 'Vivek Pandey', 'Maintenance Officer', 'IOG-024'],
  ['MEI-01113', 'Pooja Sharma', 'Operation Officer', 'IOW-025'],
  ['MEI-01114', 'Jithin Joseph', 'Maintenance Officer', 'IOJ-026'],
  ['MEI-01115', 'Amit Raj', 'Operation Officer', 'IOM-027'],
  ['MEI-01116', 'Shweta Bhagat', 'Maintenance Officer', 'ION-028'],
];

const DESIGNATION_OF: Partial<Record<StandardRole, string>> = {
  'Plant Manager': 'Plant Manager',
  'Dy Plant Incharge': 'Assistant Plant Manager',
  'Maintenance Officer': 'Maintenance Officer',
  'Operation Officer': 'Operation Officer',
  'Sr. Operations and Maintenance Officer': 'Sr. O&M Officer',
};

/** Senior / support roles so every standard role has at least one person. */
const OTHERS: readonly PersonSeed[] = [
  {
    code: 'MEI-00105',
    name: 'Rajesh Menon',
    phone: '9845011122',
    aadhaar: '119988776655',
    designation: 'Head — QHSE',
    role: 'QHSE Head',
    plants: 'ALL',
    login: 'ACTIVE',
    lastLogin: '2026-10-15 17:45',
  },
  {
    code: 'MEI-00101',
    name: 'Suresh Agarwal',
    phone: '9810022233',
    aadhaar: '118877665544',
    designation: 'General Manager — Operations',
    role: 'Management',
    plants: 'ALL',
    login: 'ACTIVE',
    lastLogin: '2026-10-14 11:05',
  },
  {
    code: 'MEI-00130',
    name: 'Harpreet Kaur',
    phone: '9815033344',
    aadhaar: '117766554433',
    designation: 'Zonal Manager — North',
    role: 'Zonal Manager',
    plants: ['BLT-001', 'BPR-009', 'HPR-018', 'IOG-024', 'IOW-025'],
    login: 'ACTIVE',
    lastLogin: '2026-10-15 09:10',
  },
  {
    code: 'MEI-00140',
    name: 'Nilesh Joshi',
    phone: '9822044455',
    aadhaar: '116655443322',
    designation: 'FM Co-ordinator',
    role: 'FM Co-ordinator',
    plants: ['BPS-004', 'HPC-020', 'ION-028'],
    login: 'ACTIVE',
    lastLogin: '2026-10-13 16:30',
  },
  {
    code: 'MEI-00150',
    name: 'Farhan Qureshi',
    phone: '9833055566',
    aadhaar: '115544332211',
    designation: 'Accounts Executive',
    role: 'Accounts Officer',
    plants: ['HPY-011', 'BPS-004', 'CPC-002', 'IOK-021'],
    login: 'ACTIVE',
    lastLogin: '2026-10-12 12:00',
  },
  {
    code: 'MEI-00160',
    name: 'Divya Krishnan',
    phone: '9840066677',
    aadhaar: '114433221100',
    designation: 'Asst Manager — HSSE',
    role: 'Asst Manager HSSE',
    plants: ['HPY-011', 'BPD-014', 'CPC-002'],
    login: 'ACTIVE',
    lastLogin: '2026-10-16 08:50',
  },
  {
    code: 'MEI-00170',
    name: 'Gopal Das',
    phone: '9832077788',
    aadhaar: '113322110099',
    designation: 'Office Assistant',
    role: 'Staff',
    plants: ['HPB-017'],
    login: 'ACTIVE',
    lastLogin: '2026-10-10 10:00',
  },
];

const phoneFor = (code: string): string =>
  `98${code.slice(-4)}${code.slice(-4, -2)}${code.slice(-2)}`;
const aadhaarFor = (code: string): string => `1${code.slice(-4).padStart(11, '7')}`;

export const PEOPLE: readonly PersonSeed[] = [
  ...MOCKUP_PEOPLE,
  ...PLANT_MANAGERS.map(([code, name, plant]): PersonSeed => ({
    code,
    name,
    phone: phoneFor(code),
    aadhaar: aadhaarFor(code),
    designation: 'Plant Manager',
    role: 'Plant Manager',
    plants: [plant],
    login: 'ACTIVE',
    lastLogin: '2026-10-15 18:00',
  })),
  ...ENTRY_OFFICERS.map(([code, name, role, plant]): PersonSeed => ({
    code,
    name,
    phone: phoneFor(code),
    aadhaar: aadhaarFor(code),
    designation: DESIGNATION_OF[role] ?? role,
    role,
    plants: [plant],
    login: 'ACTIVE',
    lastLogin: '2026-10-15 21:30',
  })),
  ...OTHERS,
];

/** KEKA designation → portal role(s) (mockup “Designation map”; Trainee Engineer unmapped). */
export const DESIGNATION_MAP: readonly [string, readonly StandardRole[]][] = [
  ['Plant Manager', ['Plant Manager']],
  ['Assistant Plant Manager', ['Dy Plant Incharge']],
  ['Maintenance Officer', ['Maintenance Officer']],
  ['Operation Officer', ['Operation Officer']],
  ['Sr. O&M Officer', ['Sr. Operations and Maintenance Officer']],
  ['Safety Officer', ['Safety Officer']],
  ['Asst Manager — HSSE', ['Asst Manager HSSE', 'Safety Officer']],
  ['Zonal Manager — South', ['Zonal Manager']],
  ['Zonal Manager — North', ['Zonal Manager']],
  ['Head — QHSE', ['QHSE Head']],
  ['Accounts Executive', ['Accounts Officer']],
  ['FM Co-ordinator', ['FM Co-ordinator']],
  ['General Manager — Operations', ['Management']],
  ['Office Assistant', ['Staff']],
];

/** Who enters each plant's Daily MIS / exceptions in the generated history. */
export function entryPersonFor(plantCode: string): string {
  const explicit: Record<string, string> = {
    'HPY-011': 'MEI-00733',
    'HPB-017': 'MEI-00611',
    'BPS-004': 'MEI-00742',
    'CPC-002': 'MEI-00756',
    'IOK-021': 'MEI-00455',
    'IOW-025': 'MEI-01113',
  };
  const fromList = ENTRY_OFFICERS.find((e) => e[3] === plantCode)?.[0];
  const code = explicit[plantCode] ?? fromList;
  if (code === undefined) throw new Error(`No entry person for ${plantCode}`);
  return code;
}
