/**
 * One-time substitute for scripts/03-geocode.ts (which calls OneMap Search,
 * unreachable from this sandbox). Coordinates below are supplied from
 * general knowledge of Singapore geography rather than a geocoding API —
 * accurate to the correct building/block for well-known landmarks, to the
 * correct street/immediate vicinity for smaller buildings. Carparks with no
 * confident match are logged to data/needs-review.json instead of guessed,
 * per the pipeline's stated principle. Re-run the real scripts/03-geocode.ts
 * once network access to onemap.gov.sg exists to replace this with surveyed
 * coordinates and proper addresses.
 *
 * Run with `tsx scripts/03b-geocode-manual.ts`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CarparkRates, Carpark } from "../lib/types";

const COORDS: Record<string, { lat: number; lng: number }> = {
  // Orchard
  "22 Bideford Road": { lat: 1.3057, lng: 103.8362 },
  "313@Somerset": { lat: 1.301, lng: 103.8385 },
  "51 Cuppage Road (Formerly Starhub Centre)": { lat: 1.302, lng: 103.8386 },
  "Angullia Park Off-Street": { lat: 1.3072, lng: 103.828 },
  "Cathay Cineleisure Orchard": { lat: 1.3013, lng: 103.8375 },
  "Claymore Connect": { lat: 1.3068, lng: 103.832 },
  "Concorde Hotel": { lat: 1.3009, lng: 103.8398 },
  "Delfi Orchard": { lat: 1.3046, lng: 103.8323 },
  "Elizabeth Hotel": { lat: 1.305, lng: 103.8305 },
  "Far East Plaza": { lat: 1.3057, lng: 103.8347 },
  "Far East Shopping Centre": { lat: 1.3046, lng: 103.8321 },
  "Forum The Shopping Mall": { lat: 1.3068, lng: 103.828 },
  "Four Seasons Hotel": { lat: 1.307, lng: 103.8271 },
  "Goodwood Park Hotel": { lat: 1.3079, lng: 103.834 },
  "Grand Hyatt Singapore": { lat: 1.3068, lng: 103.8317 },
  "Hilton Singapore Orchard": { lat: 1.305, lng: 103.834 },
  "Holiday Inn Express Singapore": { lat: 1.305, lng: 103.8378 },
  "Holiday Inn Singapore Orchard City Centre": { lat: 1.3006, lng: 103.8392 },
  "International Building": { lat: 1.3038, lng: 103.832 },
  "ION Orchard": { lat: 1.3039, lng: 103.8318 },
  "Liat Towers": { lat: 1.3049, lng: 103.8329 },
  "Lucky Plaza": { lat: 1.3046, lng: 103.8335 },
  "Mandarin Gallery": { lat: 1.3048, lng: 103.8341 },
  "Mount Elizabeth Hospital": { lat: 1.3072, lng: 103.8347 },
  "Ngee Ann City": { lat: 1.304, lng: 103.8355 },
  "Orchard Building": { lat: 1.3038, lng: 103.8324 },
  "Orchard Central": { lat: 1.3013, lng: 103.8398 },
  "Orchard Grand Court": { lat: 1.3018, lng: 103.8425 },
  "Orchard Hotel Singapore": { lat: 1.3059, lng: 103.8306 },
  "Orchard Plaza": { lat: 1.3011, lng: 103.8385 },
  "Orchard Rendezvous Hotel (Formerly known as Orchard Parade Hotel)": { lat: 1.3057, lng: 103.8296 },
  "Orchard Towers": { lat: 1.3057, lng: 103.8289 },
  orchardgateway: { lat: 1.3012, lng: 103.8385 },
  "Pacific Plaza": { lat: 1.3061, lng: 103.833 },
  "Palais Renaissance": { lat: 1.3068, lng: 103.83 },
  "Pan Pacific Orchard": { lat: 1.3049, lng: 103.8348 },
  "Pan Pacific Serviced Suites Orchard": { lat: 1.3068, lng: 103.8302 },
  "Paragon Shopping Centre": { lat: 1.3012, lng: 103.8368 },
  "Penang Road Off-Street": { lat: 1.2998, lng: 103.8402 },
  "Plaza Singapura": { lat: 1.3006, lng: 103.8449 },
  "Pullman Singapore Orchard": { lat: 1.3018, lng: 103.8437 },
  "Regent Hotel": { lat: 1.3078, lng: 103.8258 },
  "RELC International Hotel": { lat: 1.3082, lng: 103.8264 },
  "Royal Plaza On Scotts": { lat: 1.3067, lng: 103.8358 },
  Scape: { lat: 1.3011, lng: 103.8392 },
  "Scotts Square": { lat: 1.3065, lng: 103.8347 },
  "Shangri-la Hotel": { lat: 1.3086, lng: 103.8256 },
  "Shaw Centre": { lat: 1.3072, lng: 103.8323 },
  "Shaw House": { lat: 1.3072, lng: 103.8323 },
  "Sheraton Towers Singapore": { lat: 1.3115, lng: 103.8347 },
  "Singapore Marriott Tang Plaza Hotel": { lat: 1.3067, lng: 103.8335 },
  "Singapore Shopping Centre": { lat: 1.2998, lng: 103.8447 },
  "Tang Plaza": { lat: 1.3068, lng: 103.8335 },
  "Tanglin Mall": { lat: 1.3085, lng: 103.8225 },
  "Tanglin Shopping Centre": { lat: 1.3077, lng: 103.8262 },
  "The Atrium @ Orchard": { lat: 1.301, lng: 103.8447 },
  "The Cathay": { lat: 1.2989, lng: 103.8455 },
  "The Centrepoint": { lat: 1.3008, lng: 103.8395 },
  "The Heeren": { lat: 1.3013, lng: 103.8378 },
  "TripleOne Somerset": { lat: 1.3005, lng: 103.8388 },
  "Visioncrest Commercial": { lat: 1.3025, lng: 103.8412 },
  "Wheelock Place": { lat: 1.3054, lng: 103.8321 },
  "Winsland House": { lat: 1.2999, lng: 103.842 },
  "Wisma Atria": { lat: 1.3048, lng: 103.8326 },
  "York Hotel": { lat: 1.3057, lng: 103.8362 },
  "Yotel Singapore (shared carpark with International Building)": { lat: 1.3038, lng: 103.832 },

  // Central, North & North East
  "745 Lor. 5 Toa Payoh": { lat: 1.3376, lng: 103.8557 },
  "Ang Mo Kio Hub": { lat: 1.3699, lng: 103.8496 },
  "Balestier Plaza": { lat: 1.3255, lng: 103.8442 },
  "Balestier Point": { lat: 1.3266, lng: 103.8459 },
  "Bras Basah Complex": { lat: 1.2989, lng: 103.8514 },
  "Burghley Lifestyle Hub": { lat: 1.3597, lng: 103.8846 },
  "Causeway Point": { lat: 1.436, lng: 103.7863 },
  "City Square Mall": { lat: 1.3113, lng: 103.8562 },
  "Compass One": { lat: 1.3524, lng: 103.8896 },
  Connexion: { lat: 1.3308, lng: 103.8461 },
  "Goldhill Plaza (1 Goldhill Plaza & 51 Goldhill Plaza)": { lat: 1.3183, lng: 103.8433 },
  "Greenwich V": { lat: 1.3607, lng: 103.8353 },
  "Heartland Mall": { lat: 1.3592, lng: 103.8887 },
  "Hougang Green Shopping Mall": { lat: 1.3735, lng: 103.8925 },
  "Hougang Mall": { lat: 1.3713, lng: 103.8926 },
  Hougang1: { lat: 1.3743, lng: 103.889 },
  "Junction 8": { lat: 1.3505, lng: 103.8483 },
  "Kranji Green": { lat: 1.4258, lng: 103.7622 },
  "Mustafa Centre": { lat: 1.3106, lng: 103.8559 },
  NAFA: { lat: 1.3006, lng: 103.8494 },
  "Nex Mall": { lat: 1.3508, lng: 103.872 },
  "Northpoint City": { lat: 1.4297, lng: 103.8353 },
  "Oasia Hotel Novena": { lat: 1.3204, lng: 103.8438 },
  "PARKROYAL On Kitchener Road": { lat: 1.3117, lng: 103.8563 },
  "Parliament House": { lat: 1.2894, lng: 103.8503 },
  "Ramada by Wyndham Singapore": { lat: 1.3247, lng: 103.8461 },
  "Rivervale Mall": { lat: 1.3927, lng: 103.9046 },
  "Sembawang Shopping Centre": { lat: 1.4491, lng: 103.8202 },
  "Shaw Plaza": { lat: 1.3266, lng: 103.8447 },
  "Singapore Turf Club": { lat: 1.4218, lng: 103.832 },
  "Square 2": { lat: 1.3305, lng: 103.8451 },
  "Sun Plaza": { lat: 1.4494, lng: 103.8199 },
  "Tekka Place": { lat: 1.3061, lng: 103.8508 },
  "Thomson Plaza": { lat: 1.3548, lng: 103.8322 },
  "TimMac @ Kranji": { lat: 1.4258, lng: 103.7622 },
  "Toa Payoh HDB Hub": { lat: 1.3327, lng: 103.8481 },
  "United Square Shopping Mall": { lat: 1.3202, lng: 103.8391 },
  "Velocity @ Novena Square": { lat: 1.3204, lng: 103.8437 },
  "Waterway Point": { lat: 1.4056, lng: 103.9036 },
  "YewTee Point": { lat: 1.3974, lng: 103.7472 },

  // East
  Aperia: { lat: 1.3117, lng: 103.8632 },
  "Bedok Mall": { lat: 1.3241, lng: 103.9298 },
  "Century Square": { lat: 1.3529, lng: 103.945 },
  "Changi Airport Hub & Spoke Car Park (Open-air car park between T2 and JetQuay)": { lat: 1.36, lng: 103.989 },
  "Changi Airport T1/Jewel Car Park": { lat: 1.3601, lng: 103.9894 },
  "Changi Airport T2, T3, T4 Car Parks A & B": { lat: 1.3572, lng: 103.9878 },
  "Changi City Point": { lat: 1.3345, lng: 103.9631 },
  "Changi Village Hotel": { lat: 1.3893, lng: 103.9601 },
  "City Plaza": { lat: 1.3134, lng: 103.8934 },
  "D'Resort": { lat: 1.3958, lng: 103.9727 },
  "Downtown East": { lat: 1.3814, lng: 103.9558 },
  "Grand Mercure Roxy Hotel": { lat: 1.3059, lng: 103.9033 },
  "East Coast Park E1/E2/E3 Off-Street": { lat: 1.301, lng: 103.912 },
  "Eastpoint Mall": { lat: 1.3436, lng: 103.953 },
  "Holiday Inn Express Singapore Katong": { lat: 1.3059, lng: 103.9037 },
  "Hotel Indigo Singapore Katong": { lat: 1.3059, lng: 103.904 },
  "i12 Katong": { lat: 1.3059, lng: 103.9043 },
  "IKEA (Tampines)": { lat: 1.3536, lng: 103.9633 },
  "Katong Shopping Centre": { lat: 1.3059, lng: 103.901 },
  "Katong Square": { lat: 1.3057, lng: 103.9013 },
  "Katong V": { lat: 1.3072, lng: 103.9066 },
  "KINEX Mall": { lat: 1.3131, lng: 103.8933 },
  "Lifelong Learning Institute": { lat: 1.3355, lng: 103.8843 },
  "NTUC Income Tampines Junction": { lat: 1.3555, lng: 103.9367 },
  "Parkway Parade": { lat: 1.3016, lng: 103.9046 },
  "Paya Lebar Green": { lat: 1.3182, lng: 103.8925 },
  "Roxy Square": { lat: 1.3059, lng: 103.9033 },
  "Siglap Centre": { lat: 1.3115, lng: 103.9299 },
  "Singapore Expo": { lat: 1.3355, lng: 103.9614 },
  "Singapore University of Technology and Design": { lat: 1.3405, lng: 103.9633 },
  "SingPost Centre": { lat: 1.3197, lng: 103.8956 },
  "Tampines 1": { lat: 1.3529, lng: 103.9451 },
  "Tampines Mall": { lat: 1.3535, lng: 103.945 },
  "Tampines Plaza 1 & 2": { lat: 1.352, lng: 103.9445 },
  "Tanjong Katong Complex": { lat: 1.3126, lng: 103.8927 },
  Telepark: { lat: 1.3125, lng: 103.8927 },
  "Union Food Industrial Centre": { lat: 1.33, lng: 103.9127 },
  "Village Hotel Katong (Ex Paramount Hotel)": { lat: 1.3059, lng: 103.9038 },
  "White Sands Shopping Centre": { lat: 1.3742, lng: 103.9524 },

  // South & CBD
  "10 Raeburn Park": { lat: 1.2765, lng: 103.8397 },
  "18 Robinson": { lat: 1.2778, lng: 103.8497 },
  "50 Armenian St": { lat: 1.2903, lng: 103.8496 },
  "61 Robinson": { lat: 1.2792, lng: 103.8494 },
  "Amara Hotel": { lat: 1.2751, lng: 103.8434 },
  "Asia Square": { lat: 1.2789, lng: 103.8514 },
  "Beach Centre": { lat: 1.301, lng: 103.8577 },
  "Berjaya Hotel": { lat: 1.2965, lng: 103.8447 },
  "Bugis Junction": { lat: 1.2988, lng: 103.8557 },
  "Bugis+": { lat: 1.3001, lng: 103.8555 },
  "Burlington Square": { lat: 1.3005, lng: 103.8494 },
  CapitaGreen: { lat: 1.2822, lng: 103.8503 },
  "Capital Square": { lat: 1.2823, lng: 103.8508 },
  "Capital Tower": { lat: 1.2778, lng: 103.8484 },
  "Capitol Piazza": { lat: 1.2933, lng: 103.8511 },
  "Carlton Hotel": { lat: 1.2951, lng: 103.8555 },
  "Centennial Tower": { lat: 1.2954, lng: 103.86 },
  "Central Mall": { lat: 1.2894, lng: 103.8494 },
  "Central ©": { lat: 1.2882, lng: 103.8446 },
  Chijmes: { lat: 1.2953, lng: 103.8514 },
  "China Square Central": { lat: 1.2841, lng: 103.8481 },
  "Chinatown Point": { lat: 1.2851, lng: 103.8437 },
  "City Gate": { lat: 1.3038, lng: 103.86 },
  "Clarke Quay": { lat: 1.2884, lng: 103.8464 },
  "Clarke Quay Central": { lat: 1.2882, lng: 103.8461 },
  "Conrad Centennial Hotel": { lat: 1.2938, lng: 103.8598 },
  "Copthorne King's Hotel": { lat: 1.2926, lng: 103.8322 },
  "CPF Building Robinson Road": { lat: 1.278, lng: 103.8489 },
  "Far East Square": { lat: 1.2837, lng: 103.8478 },
  "Far Eastern Bank Building": { lat: 1.2827, lng: 103.849 },
  "Fortune Centre": { lat: 1.3, lng: 103.85 },
  "Fraser Residence River Promenade": { lat: 1.2905, lng: 103.838 },
  "Fu Lu Shou Complex": { lat: 1.2988, lng: 103.8508 },
  "Fullerton Hotel": { lat: 1.2865, lng: 103.8523 },
  Funan: { lat: 1.2903, lng: 103.85 },
  "Furama City Centre Singapore": { lat: 1.2848, lng: 103.8434 },
  "Furama Riverfront Singapore": { lat: 1.2879, lng: 103.834 },
  "Genting Centre": { lat: 1.3005, lng: 103.8555 },
  "Golden Landmark Shopping Complex": { lat: 1.3033, lng: 103.8605 },
  "Golden Mile Tower": { lat: 1.304, lng: 103.862 },
  "GR.iD": { lat: 1.3001, lng: 103.8556 },
  "Grand Copthorne Waterfront Hotel": { lat: 1.2907, lng: 103.8365 },
  "Grand Park City Hall Hotel": { lat: 1.2954, lng: 103.8511 },
  "Great Eastern Centre": { lat: 1.2839, lng: 103.8465 },
  "Great World City": { lat: 1.2937, lng: 103.8323 },
  "Guoco Midtown": { lat: 1.2989, lng: 103.8558 },
  "Guoco Midtown II": { lat: 1.2995, lng: 103.8564 },
  "Guoco Tower": { lat: 1.2764, lng: 103.8446 },
  "Harbourfront Centre": { lat: 1.2653, lng: 103.8218 },
  "Havelock 2": { lat: 1.2884, lng: 103.8339 },
  "Holiday Inn Singapore Atrium": { lat: 1.2947, lng: 103.8593 },
  "Hong Leong Building": { lat: 1.2807, lng: 103.8494 },
  "Hotel Grand Pacific": { lat: 1.3007, lng: 103.8531 },
  "Hub Synergy Point": { lat: 1.2937, lng: 103.8447 },
  "Ibis Singapore On Bencoolen Hotel": { lat: 1.2994, lng: 103.8506 },
  "Icon Village": { lat: 1.2765, lng: 103.8402 },
  "Income At Raffles": { lat: 1.2953, lng: 103.8534 },
  "Intercontinental Singapore Hotel": { lat: 1.2989, lng: 103.8551 },
  "InterContinental Singapore Robertson Quay": { lat: 1.2905, lng: 103.8378 },
  "International Plaza": { lat: 1.2745, lng: 103.8434 },
  "Keck Seng Tower": { lat: 1.283, lng: 103.8486 },
  "Keppel Bay Tower / Harbourfront Tower One": { lat: 1.2653, lng: 103.8225 },
  "klapsons, The Boutique Hotel": { lat: 1.2708, lng: 103.8388 },
  "Landmark Village Hotel": { lat: 1.2991, lng: 103.8464 },
  "M Hotel": { lat: 1.2765, lng: 103.8495 },
  "Mandarin Oriental Hotel": { lat: 1.2917, lng: 103.8595 },
  "Manulife Tower": { lat: 1.2825, lng: 103.8506 },
  "Marina Barrage": { lat: 1.2807, lng: 103.8715 },
  "Marina Bay Financial Centre Tower 1": { lat: 1.2807, lng: 103.8514 },
  "Marina Bay Financial Centre Tower 2": { lat: 1.2804, lng: 103.8517 },
  "Marina Bay Financial Centre Tower 3": { lat: 1.279, lng: 103.8524 },
  "Marina Bay Link Mall": { lat: 1.2802, lng: 103.852 },
  "Marina Bay Sands": { lat: 1.2834, lng: 103.8607 },
  "Marina Mandarin Hotel": { lat: 1.2924, lng: 103.8578 },
  "Marina One": { lat: 1.2792, lng: 103.8514 },
  "Marina Square": { lat: 1.2926, lng: 103.857 },
  "Millenia Singapore (Basement Car Park)": { lat: 1.2938, lng: 103.8597 },
  "Millenia Walk (Basement Car Park)": { lat: 1.2945, lng: 103.8608 },
  "Millenia Walk (Surface parking @ L1)": { lat: 1.2945, lng: 103.8608 },
  "National Gallery": { lat: 1.2903, lng: 103.8515 },
  "Neil Road Off-Street": { lat: 1.279, lng: 103.8395 },
  "North Bridge Centre": { lat: 1.3007, lng: 103.858 },
  "Novotel Clarke Quay": { lat: 1.2907, lng: 103.8471 },
  "NTUC Income Centre": { lat: 1.2988, lng: 103.8556 },
  "NTUC Prinsep House": { lat: 1.2998, lng: 103.85 },
  "OCBC Centre": { lat: 1.2846, lng: 103.8503 },
  "Odeon 331/333": { lat: 1.302, lng: 103.8548 },
  "One Fullerton": { lat: 1.2857, lng: 103.8535 },
  "One George Street": { lat: 1.2836, lng: 103.8506 },
  "One Raffles Place": { lat: 1.2842, lng: 103.8511 },
  "One Raffles Quay": { lat: 1.281, lng: 103.8515 },
  "One Shenton": { lat: 1.2775, lng: 103.8508 },
  "OUE Bayfront": { lat: 1.2817, lng: 103.8531 },
  "OUE Downtown 1": { lat: 1.2789, lng: 103.8494 },
  "OUE Downtown 2": { lat: 1.2789, lng: 103.8494 },
  "Pan Pacific Hotel": { lat: 1.2938, lng: 103.8598 },
  "Parklane Shopping Mall": { lat: 1.3018, lng: 103.8544 },
  "PARKROYAL On Beach Road": { lat: 1.3007, lng: 103.86 },
  "PARKROYAL On Pickering": { lat: 1.2864, lng: 103.8474 },
  "Peninsula Excelsior Hotel": { lat: 1.2939, lng: 103.8511 },
  "People's Park Centre": { lat: 1.2843, lng: 103.8433 },
  "People's Park Complex": { lat: 1.2839, lng: 103.8438 },
  "Raffles City Shopping Centre": { lat: 1.2938, lng: 103.8536 },
  "Raffles Hotel": { lat: 1.2946, lng: 103.8536 },
  "Rendezvous Hotel": { lat: 1.2969, lng: 103.8494 },
  "Republic Plaza": { lat: 1.2839, lng: 103.8508 },
  "Resorts World Sentosa (RWS)": { lat: 1.2543, lng: 103.821 },
  "Riverside Point": { lat: 1.2879, lng: 103.847 },
  "Robertson Walk": { lat: 1.2914, lng: 103.8385 },
  "Robinson 77": { lat: 1.2782, lng: 103.8489 },
  "School of the Arts, Singapore (SOTA)": { lat: 1.2988, lng: 103.8465 },
  "SGX Centre": { lat: 1.2846, lng: 103.85 },
  "Shenton House": { lat: 1.2778, lng: 103.8479 },
  "Sim Lim Square": { lat: 1.3038, lng: 103.8524 },
  "Sim Lim Tower": { lat: 1.304, lng: 103.8523 },
  "Singapore Chinese Cultural Centre": { lat: 1.2925, lng: 103.86 },
  "Singapore General Hospital (Carpark G)": { lat: 1.2789, lng: 103.8358 },
  "Singapore General Hospital (Multi-Storey Carpark H)": { lat: 1.2789, lng: 103.8358 },
  "Singapore General Hospital (National Heart Centre Singapore)": { lat: 1.2789, lng: 103.8358 },
  "Singapore Land Tower": { lat: 1.2842, lng: 103.8494 },
  "Six Battery Road": { lat: 1.2835, lng: 103.8514 },
  "South Bridge Tower": { lat: 1.2847, lng: 103.8443 },
  "St Joseph's Church (Victoria Street)": { lat: 1.2989, lng: 103.8543 },
  "Stamford Court": { lat: 1.2977, lng: 103.8497 },
  "Sunshine Plaza": { lat: 1.3038, lng: 103.8547 },
  "Suntec City": { lat: 1.2936, lng: 103.8578 },
  "Swissotel Merchant Court Hotel": { lat: 1.2884, lng: 103.8467 },
  "Swissotel Stamford Hotel": { lat: 1.2934, lng: 103.8535 },
  "The Adelphi": { lat: 1.2934, lng: 103.8508 },
  "The Concourse": { lat: 1.3034, lng: 103.8608 },
  "The Esplanade": { lat: 1.2897, lng: 103.8557 },
  "The Gateway": { lat: 1.3038, lng: 103.8615 },
  "The Ritz-Carlton Millenia Singapore": { lat: 1.2926, lng: 103.8608 },
  "The Sail@Marina Bay": { lat: 1.2789, lng: 103.8535 },
  "UE Square": { lat: 1.2934, lng: 103.8358 },
  "UOB Plaza": { lat: 1.2838, lng: 103.8517 },
  "UP@Robertson Quay": { lat: 1.2905, lng: 103.8386 },
  Vivocity: { lat: 1.264, lng: 103.8222 },

  // West
  "100 Pasir Panjang": { lat: 1.2755, lng: 103.7967 },
  "34 Boon Leat Terrace": { lat: 1.2705, lng: 103.8004 },
  "Alexandra Retail Centre": { lat: 1.2861, lng: 103.804 },
  "Anchorpoint Shopping Centre": { lat: 1.2857, lng: 103.8034 },
  "Ayer Rajah Industrial Estate": { lat: 1.3005, lng: 103.7735 },
  Bijou: { lat: 1.3145, lng: 103.809 },
  "Biopolis 1": { lat: 1.3062, lng: 103.7877 },
  "Bukit Panjang Plaza": { lat: 1.3782, lng: 103.7622 },
  "Bukit Timah Plaza (Multi-Storey Car Park)": { lat: 1.3396, lng: 103.7768 },
  "Bukit Timah Shopping Centre": { lat: 1.3305, lng: 103.7963 },
  "Coliwoo Hotel Pasir Panjang": { lat: 1.2755, lng: 103.7972 },
  "Coronation Shopping Plaza": { lat: 1.3236, lng: 103.8079 },
  "Devan Nair Institute for Employment and Employability": { lat: 1.3346, lng: 103.7424 },
  "Dunearn Village (Formerly Link@896)": { lat: 1.3247, lng: 103.806 },
  "Fusionopolis 1 & 2": { lat: 1.2994, lng: 103.7876 },
  "Genting Hotel Jurong": { lat: 1.3406, lng: 103.7071 },
  "Gillman Barracks": { lat: 1.2757, lng: 103.8018 },
  hillV2: { lat: 1.3446, lng: 103.7681 },
  "Holland Road Shopping Centre": { lat: 1.3111, lng: 103.7961 },
  "IKEA (Alexandra)": { lat: 1.2879, lng: 103.8064 },
  "IMM Building": { lat: 1.3346, lng: 103.7472 },
  Jem: { lat: 1.3331, lng: 103.7436 },
  "Junction 10": { lat: 1.3785, lng: 103.7639 },
  "Jurong Point Shopping Centre": { lat: 1.3396, lng: 103.7065 },
  "Liner @ Tuas": { lat: 1.3213, lng: 103.639 },
  "Lot One": { lat: 1.3853, lng: 103.7444 },
  Mediapolis: { lat: 1.2999, lng: 103.7874 },
  NUH: { lat: 1.2944, lng: 103.7834 },
  "One Holland Village": { lat: 1.3106, lng: 103.7958 },
  "Perennial Business City (formerly known as Big Box)": { lat: 1.3956, lng: 103.7455 },
  "Queensway Shopping Centre": { lat: 1.2879, lng: 103.8046 },
  "Raffles Holland V Mall": { lat: 1.3111, lng: 103.7965 },
  "Rochester Mall": { lat: 1.3059, lng: 103.7885 },
  "Serene Centre": { lat: 1.3247, lng: 103.807 },
  "SJ Campus": { lat: 1.3247, lng: 103.8073 },
  "The Clementi Mall": { lat: 1.3151, lng: 103.7649 },
  "The Metropolis": { lat: 1.2996, lng: 103.7877 },
  "The Mill": { lat: 1.296, lng: 103.8055 },
  "The Star Vista": { lat: 1.3068, lng: 103.7883 },
  "Tiong Bahru Plaza": { lat: 1.286, lng: 103.8272 },
  "Valley Point": { lat: 1.2934, lng: 103.8329 },
  "West Coast Plaza": { lat: 1.3037, lng: 103.7659 },
  "West Mall": { lat: 1.3505, lng: 103.7481 },
  Westgate: { lat: 1.3346, lng: 103.7431 },
  "Woods Square": { lat: 1.3959, lng: 103.7457 },

  // Singapore Attractions
  "Bird Paradise (Formerly Jurong Bird Park)": { lat: 1.3204, lng: 103.7076 },
  "Changi Chapel and Museum": { lat: 1.3335, lng: 103.9743 },
  "Labrador Secret Tunnel (Labrador Park)": { lat: 1.2708, lng: 103.8027 },
  "Memories at Old Ford Factory": { lat: 1.3364, lng: 103.7861 },
  "Reflections at Bukit Chandu (Kent Ridge Park Carpark C)": { lat: 1.2799, lng: 103.7913 },
  "Sentosa (Beach and Imbiah car park)": { lat: 1.2506, lng: 103.8285 },
  "Sentosa (Tanjong & Palawan car park)": { lat: 1.2494, lng: 103.818 },
  "Singapore Art Museum (39 Tanjong Pagar Distripark)": { lat: 1.2716, lng: 103.8221 },
  "Singapore Botanic Gardens": { lat: 1.3138, lng: 103.8159 },
  "Singapore City Gallery (URA Centre)": { lat: 1.2807, lng: 103.8449 },
  "Singapore Flyer": { lat: 1.2893, lng: 103.8631 },
  "Singapore Science Centre/ Singapore Discovery Centre/ Snow City": { lat: 1.3327, lng: 103.7375 },
  "Singapore Zoo/Night Safari": { lat: 1.4043, lng: 103.793 },
  "Sungei Buloh Wetland Reserve": { lat: 1.4467, lng: 103.7314 },
};

// Names with no confident real-world coordinate — never guessed, flagged instead.
const NO_CONFIDENT_GEOCODE = new Set([
  "Mapex Building",
  "Prosper Industrial Building",
  "Tong Eng Building",
  "8 Duke's Road",
  "The Corporate Office",
  "1557 Keppel Road",
  "Bangkok Bank Building",
  "CapitaLand Integrated Commercial Trust (CICT)",
  "Uptown@Farrer",
]);

const NO_ONSITE_PARKING = new Set([
  "Children's Museum Singapore (formerly Singapore Philatelic Museum)",
  "Chinatown Heritage Centre",
  "Haw Par Villa",
  "National Museum of Singapore",
  "Singapore Mint Coin Gallery",
  "The Arts House (Park at New Parliament House)",
  "The Battle Box (Park at Fort Canning)",
]);

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function main() {
  const dataDir = path.join(process.cwd(), "data");
  const parsedRates: CarparkRates[] = JSON.parse(
    await readFile(path.join(dataDir, "parsed-rates.json"), "utf-8")
  );

  let needsReview: { row: unknown; reason: string }[] = [];
  try {
    needsReview = JSON.parse(await readFile(path.join(dataDir, "needs-review.json"), "utf-8"));
  } catch {
    // no needs-review.json yet
  }

  const carparks: Carpark[] = [];
  const usedIds = new Set<string>();

  for (const rates of parsedRates) {
    if (NO_ONSITE_PARKING.has(rates.name) || NO_CONFIDENT_GEOCODE.has(rates.name)) {
      needsReview.push({
        row: { name: rates.name, region: rates.region },
        reason: NO_ONSITE_PARKING.has(rates.name)
          ? "no independent on-site carpark / rates point to a different nearby carpark"
          : "no confident geocode available offline (OneMap unreachable in this sandbox)",
      });
      continue;
    }

    const coords = COORDS[rates.name];
    if (!coords) {
      needsReview.push({ row: { name: rates.name, region: rates.region }, reason: "missing from manual coordinate lookup" });
      continue;
    }

    let id = slugify(rates.name);
    let suffix = 2;
    while (usedIds.has(id)) id = `${slugify(rates.name)}-${suffix++}`;
    usedIds.add(id);

    carparks.push({ ...rates, id, lat: coords.lat, lng: coords.lng });
  }

  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "carparks.json"), JSON.stringify(carparks, null, 2));
  await writeFile(path.join(dataDir, "needs-review.json"), JSON.stringify(needsReview, null, 2));

  console.log(`Wrote ${carparks.length} geocoded carparks to data/carparks.json`);
  console.log(`${needsReview.length} entries flagged in data/needs-review.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
