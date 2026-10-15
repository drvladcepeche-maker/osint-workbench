/* curated-data.js — the hand-reviewed L1 set.
 *
 * Hand-reviewed and compiled into resources/geoint/curated.json by scripts/build-range-resources.mjs. Edit the
 * rounds here.
 *
 * Every frame in this file was opened and looked at. A frame is in the set only
 * if a beginner could name the country from something actually visible in it —
 * legible text in a distinctive script, a road sign, a plate, a flag, or
 * architecture that cannot be mistaken. Frames whose honest verdict was "you'd
 * have to already know" were rejected however high they scored on OSM signal,
 * because proximity to a named shop is not the same thing as being able to read
 * its sign.
 *
 * Order is difficulty, not geography: the first rounds should be impossible to
 * get wrong, and the ramp is what teaches.
 *
 * Built 2026-08-30T15:15:30.480Z — 20 rounds.
 * Imagery (c) Panoramax contributors, CC-BY-SA 4.0.
 */
window.CURATED = {
 "built": "2026-08-30T15:15:30.480Z",
 "count": 19,
 "rounds": [
  {
   "n": 1,
   "key": "Bulgaria-Sofia-8",
   "id": "bb4815b2-8058-4a6d-91e2-3d84c5b729d4",
   "c": [
    23.34002,
    42.64505
   ],
   "url": "https://panoramax.openstreetmap.fr/images/bb/48/15/b2/8058-4a6d-91e2-3d84c5b729d4.jpg",
   "t": "2023-08-04T09:00:00+00:00",
   "pano": false,
   "country": "Bulgaria",
   "area": "Sofia",
   "kinds": [
    "amenity_named",
    "shop_named"
   ],
   "difficulty": "gimme",
   "lesson": {
    "first": "The word ПЕРАЛНЯ, printed four times in red arc lettering across the two shop windows and once more on the small white board in the gable.",
    "firstWhere": "the yellow shopfront filling the middle of the frame",
    "narrows": "Cyrillic script. That alone puts you in the Cyrillic belt — Bulgaria, Serbia, North Macedonia, Russia, Ukraine, Belarus — and eliminates about nine tenths of Europe before you understand a single word.",
    "second": "Now check which letters are absent. No Ы, Э or Й, so not Russian. No Ј, Љ, Њ, Ћ or Џ, so not Serbian or Macedonian. What you do get is Я, in ПЕРАЛНЯ and in БОЯДИСВАНЕ НА ДРЕХИ along the bottom of the left window. That combination leaves Bulgarian.",
    "secondWhere": "the blue strips along the bottom of both windows — БОЯДИСВАНЕ НА ДРЕХИ on the left, ХИМИЧЕСКО ЧИСТЕНЕ on the right",
    "note": "Bulgaria's single strongest letter, Ъ used as an ordinary vowel inside a word, does not appear anywhere in this frame. That is normal and worth getting used to: the tell you want is often missing, and you fall back on vocabulary instead. A Russian laundry is a ПРАЧЕЧНАЯ and a Serbian one a ПЕРИОНИЦА — ПЕРАЛНЯ is Bulgarian.",
    "atlas": [
     {
      "key": "c:cyrillic-tells",
      "label": "Telling the Cyrillic countries apart"
     },
     {
      "key": "n:Bulgaria",
      "label": "Bulgaria"
     }
    ]
   }
  },
  {
   "n": 2,
   "key": "Taiwan-Taipei-3",
   "id": "6338baa3-c6b2-4ae6-9549-e1e7baee4619",
   "c": [
    121.539073,
    25.055001
   ],
   "url": "https://panoramax.osm.tw/api/pictures/6338baa3-c6b2-4ae6-9549-e1e7baee4619/hd.jpg",
   "t": "2025-09-06T08:54:22+00:00",
   "pano": true,
   "country": "Taiwan",
   "area": "Taipei",
   "kinds": [
    "bus_stop",
    "shop_named",
    "amenity_named"
   ],
   "difficulty": "gimme",
   "lesson": {
    "first": "Chinese characters on every shopfront — the orange board reading 五吉号 with AWAKENING under it, and the red 東光 sign immediately to its right.",
    "firstWhere": "turn towards the low shop buildings with the long rank of scooters parked nose-in against the kerb",
    "narrows": "Han characters, so mainland China, Taiwan, Hong Kong, Macau, Singapore, or a Chinatown somewhere else. It is not Japan and not Korea: Japanese text always mixes in kana (は, の, ン) and Korean is written in square hangul blocks. Neither appears here.",
    "second": "Two independent checks split that list. First, the characters are traditional, not simplified: 東 (simplified 东) on the red sign, and 試營運期間 買一送一 on the pink banner uses 營, 運 and 買 where the mainland writes 营, 运, 买. Traditional forms rule out mainland China and Singapore. Second, look at the road itself: the white car ahead is driving on the right of a double yellow centre line, and Hong Kong and Macau both drive on the left. What is left is Taiwan.",
    "secondWhere": "the pink banner over the left-hand shop, then the road surface directly in front of you",
    "note": "Traditional-versus-simplified plus driving side is a two-question decision tree that settles the whole Chinese-speaking world, and neither question needs you to know what any character means.",
    "atlas": [
     {
      "key": "c:writing-system",
      "label": "Writing system and diacritics"
     },
     {
      "key": "c:driving-side",
      "label": "Driving side"
     },
     {
      "key": "c:road-markings",
      "label": "Road markings"
     }
    ]
   }
  },
  {
   "n": 3,
   "key": "Turkey-Istanbul-2",
   "id": "aa76b553-d254-47f9-b395-3fef596666e9",
   "c": [
    28.975585,
    41.014855
   ],
   "url": "https://panoramax.openstreetmap.fr/images/aa/76/b5/53/d254-47f9-b395-3fef596666e9.jpg",
   "t": "2026-05-06T14:27:22.359000+00:00",
   "pano": true,
   "country": "Turkey",
   "area": "Istanbul",
   "kinds": [
    "amenity_named",
    "shop_named"
   ],
   "difficulty": "gimme",
   "lesson": {
    "first": "The two brown heritage signs stacked on one pole: İstanbul Kültür Varlıklarını Koruma Müdürlükleri above, and Mısır Çarşısı (Egyptian Bazaar) below it.",
    "firstWhere": "high above the traffic light, at the top left of the crowded shopping street — turn until the yellow taxis are on your right",
    "narrows": "The sign names the city, and even translates itself into English. Take the free answer, then go back and learn the letters, because they are what will identify Turkey when no city name is in shot.",
    "second": "Turkish is the only language in the world that treats dotted İ and dotless ı as two separate letters, and both are on that brown sign: İstanbul, Çarşısı, Varlıklarını. Add ç, ş, ğ and ü and no other alphabet matches. The rank of bright yellow taxis on the right, and the tram wires overhead, confirm a large Turkish city.",
    "secondWhere": "the same brown signs; the taxis are on the road to the right of the junction",
    "atlas": [
     {
      "key": "c:writing-system",
      "label": "Writing system and diacritics"
     },
     {
      "key": "n:Turkey",
      "label": "Turkey"
     }
    ]
   }
  },
  {
   "n": 4,
   "key": "USA-Portland-8",
   "id": "2cae04b5-e4d5-434c-ad93-e9af3fb0ebe2",
   "c": [
    -122.661453,
    45.517275
   ],
   "url": "https://panoramax.openstreetmap.fr/images/2c/ae/04/b5/e4d5-434c-ad93-e9af3fb0ebe2.jpg",
   "t": "2025-08-08T22:38:49.296000+00:00",
   "pano": false,
   "country": "USA",
   "area": "Portland",
   "kinds": [
    "shop_named",
    "amenity_named",
    "route_ref"
   ],
   "difficulty": "easy",
   "lesson": {
    "first": "The rooftop billboard reading KEEP PORTLAND WEIRD / AND YOUR CLAW COOL, with GRAB LIFE BY THE CLAW on its right half.",
    "firstWhere": "right of centre, on the roof of the dark brick building across the freeway",
    "narrows": "It prints the city name, so this one is free. The useful skill is that the frame already told you the country before you read anything.",
    "second": "The road. Multiple lanes, white dashed lane lines, a low concrete-and-steel guardrail, traffic on the right, and a black-on-white rectangular sign on the right shoulder spelling out SPEED LIMIT with the number under it. Europe puts a speed limit in a red-ringed circle with nothing but a numeral. A rectangular white plate that writes the words out is the North American MUTCD pattern, and that is the fastest continent-level call you can make from a road photo.",
    "secondWhere": "the small white sign on the right-hand shoulder, just below the billboard",
    "atlas": [
     {
      "key": "c:road-signs",
      "label": "Road signs — shape, colour, font"
     },
     {
      "key": "c:road-markings",
      "label": "Road markings"
     },
     {
      "key": "c:driving-side",
      "label": "Driving side"
     }
    ]
   }
  },
  {
   "n": 5,
   "key": "Greece-Athens-7",
   "id": "bda8a12f-44d3-4513-9727-058efcea97ca",
   "c": [
    23.72675,
    37.978981
   ],
   "url": "https://panoramax.mapcomplete.org/permanent/bd/a8/a1/2f/44d3-4513-9727-058efcea97ca.jpg",
   "t": "2025-05-17T08:43:56+00:00",
   "pano": false,
   "country": "Greece",
   "area": "Athens",
   "kinds": [
    "shop_named",
    "amenity_named"
   ],
   "difficulty": "easy",
   "lesson": {
    "first": "Not the big sign. The largest and cleanest text in the frame is CRÈME ROYALE — BAKE HOUSE CAFÉ, which is French and English and tells you nothing about where you are. Look one shop to the left, at the black fascia reading …Ι ΚΑΡΠΟΙ / …ΡΡΙΑΣ / …ΚΑ ΠΡΟΪΟΝΤΑ.",
    "firstWhere": "the far left edge of the frame, on the black fascia above the shop and the tall red board below it",
    "narrows": "The Greek alphabet, which in Europe means Greece or Cyprus and nothing else. Note ΠΡΟΪΟΝΤΑ carries a diaeresis on the Ι — Greek uses that mark to break a vowel pair, and seeing it is a quick confirmation you are reading Greek rather than a stylised Latin font.",
    "second": "The red board is bilingual, line by line: Ξηροί Καρποί / Nuts, Αποξηραμένα Φρούτα / Dried fruits, Μέλι Καλαβρύτων / Honey. Two Greek-language sources agreeing beats one, and the English half lets you check that you have actually read the Greek correctly.",
    "secondWhere": "the narrow red menu board at chest height, just left of the shop entrance",
    "note": "The habit this round is teaching is more valuable than the answer: the loudest sign in a frame is usually a brand, and brands travel. The small local signage next to it is what stays put.",
    "atlas": [
     {
      "key": "c:writing-system",
      "label": "Writing system and diacritics"
     },
     {
      "key": "n:Greece",
      "label": "Greece"
     }
    ]
   }
  },
  {
   "n": 6,
   "key": "Poland-Warsaw-8",
   "id": "493ab766-0923-4c87-85f2-7ccbfa6a597a",
   "c": [
    21.00686,
    52.24377
   ],
   "url": "https://panoramax.openstreetmap.fr/images/49/3a/b7/66/0923-4c87-85f2-7ccbfa6a597a.jpg",
   "t": "2023-08-02T10:00:00+00:00",
   "pano": false,
   "country": "Poland",
   "area": "Warsaw",
   "kinds": [
    "amenity_named",
    "shop_named",
    "tourism_info"
   ],
   "difficulty": "easy",
   "lesson": {
    "first": "The lit fascia across the top of the shopfront: Pralnia samoobsługowa, with Laundromat underneath it.",
    "firstWhere": "the illuminated black band above the windows, running the full width of the frame",
    "narrows": "Latin script with a crossed L — the ł in samoobsługowa. Ł exists in Polish and essentially nowhere else you will meet in Europe. One letter, one country.",
    "second": "Look through the glass at the green emergency-exit sign on the right, reading WYJŚCIE in mirror image. That gives you Ś, an s with an acute accent, which is again Polish rather than Czech or Slovak (they would write š with a caron). Two different Polish-only diacritics in one frame.",
    "secondWhere": "reversed on the green exit sign inside the shop, upper right",
    "note": "The English gloss Laundromat is doing you a favour: it lets you confirm the meaning without knowing the language, which is how you check you have not misread a stylised font.",
    "atlas": [
     {
      "key": "c:writing-system",
      "label": "Writing system and diacritics"
     },
     {
      "key": "n:Poland",
      "label": "Poland"
     }
    ]
   }
  },
  {
   "n": 7,
   "key": "Croatia-Split-8",
   "id": "7108ce80-1c06-4402-a67f-487417afca42",
   "c": [
    16.461097,
    43.50587
   ],
   "url": "https://panoramax.osm-hr.org/permanent/71/08/ce/80/1c06-4402-a67f-487417afca42.jpg",
   "t": "2024-01-06T09:46:06+00:00",
   "pano": false,
   "country": "Croatia",
   "area": "Split",
   "kinds": [
    "shop_named",
    "bus_stop",
    "amenity_named",
    "route_ref"
   ],
   "difficulty": "easy",
   "lesson": {
    "first": "The stack of yellow business direction signs on the right-hand pole. Read it from the bottom: the last sign in the stack says Adriatic.hr.",
    "firstWhere": "on the pole at the right-hand kerb, just past the orange-and-black office building",
    "narrows": ".hr is Croatia's country domain, printed on a fixed sign at the roadside. A company's own web address is the single most reliable text clue in street imagery, because a business advertises the country it trades in and a domain cannot be a coincidence the way a brand name can.",
    "second": "Two signs above it, POLIKLINIKA MAKEOVER. Poliklinika is Serbo-Croatian, written in Latin script — which is consistent with Croatia and Bosnia but not with Serbia, where the same word normally appears in Cyrillic as ПОЛИКЛИНИКА.",
    "secondWhere": "second sign from the top of the same stack",
    "note": "Whenever a frame contains a stack of business direction signs, go there first. It is the densest concentration of country-bearing text you will find in any street scene — several company names, often a domain, all at a readable size.",
    "atlas": [
     {
      "key": "c:domains-phones",
      "label": "Domains and phone numbers on signage"
     },
     {
      "key": "n:Croatia",
      "label": "Croatia"
     }
    ]
   }
  },
  {
   "n": 8,
   "key": "Belgium-Brussels-8",
   "id": "a2bac292-e88d-4362-b8c5-982c29d9fd14",
   "c": [
    4.367755,
    50.850415
   ],
   "url": "https://images.panoramax.osm.be/permanent/a2/ba/c2/92/e88d-4362-b8c5-982c29d9fd14.jpg",
   "t": "2026-06-11T14:17:47+00:00",
   "pano": true,
   "country": "Belgium",
   "area": "Brussels",
   "kinds": [
    "amenity_named",
    "shop_named",
    "route_ref"
   ],
   "difficulty": "easy",
   "lesson": {
    "first": "The small orange-bordered red panel above the corner tobacconist's window. It reads Tabac Cigarettes on the left and Tabak Sigaretten on the right — the same two words, twice, in two languages.",
    "firstWhere": "turn to the corner shop with the arched window and the red lotto sign above it; the panel is immediately above the window, at first-floor level",
    "narrows": "French and Dutch side by side, given equal weight on the same commercial sign. That pairing is Belgium — Brussels is officially bilingual and signage has to carry both. France would be French alone, the Netherlands Dutch alone.",
    "second": "The red fascia below it reads Librairie des Cultes, and the white van across the square carries the French slogan Apporté avec soin. So French is genuinely in use here, not decorative — which is what makes the Dutch half of that panel meaningful rather than a translation for tourists.",
    "secondWhere": "the red shop fascia under the panel, and the van parked across the paved square behind you",
    "atlas": [
     {
      "key": "c:writing-system",
      "label": "Writing system and diacritics"
     },
     {
      "key": "c:street-furniture",
      "label": "Street furniture — signs, numbers, markers, bins"
     }
    ]
   }
  },
  {
   "n": 9,
   "key": "Romania-Bucharest-7",
   "id": "79da4f0c-e7d8-4e61-a215-302c5af4efcf",
   "c": [
    26.101361,
    44.479605
   ],
   "url": "https://panoramax.openstreetmap.fr/images/79/da/4f/0c/e7d8-4e61-a215-302c5af4efcf.jpg",
   "t": "2026-07-14T11:55:46.519465+00:00",
   "pano": false,
   "country": "Romania",
   "area": "Bucharest",
   "kinds": [
    "bus_stop",
    "amenity_named",
    "shop_named"
   ],
   "difficulty": "medium",
   "lesson": {
    "first": "The green banner hanging from the lamp post. Its bottom line reads WWW.BHB.RO.",
    "firstWhere": "the right-hand edge of the frame, on the lamp post standing against the sky — the banner is the only text-bearing object in the picture",
    "narrows": ".ro is Romania. This frame is mostly sky and glass, and the entire answer lives on two small banners in one corner — which is the real lesson: when a frame looks empty, do not give up, sweep the edges and the poles.",
    "second": "The white banner right beside it, for a medical clinic, gives you the language itself: MICROCLINICA AVIAȚIEI and MEDICINĂ INTERNĂ. The Ă is an a with a breve and the Ț is a t with a comma below it — not a cedilla. That comma-below pair, Ș and Ț, is Romanian and is the thing to look for when no domain is visible. The phone number below starts 021, the Bucharest area code.",
    "secondWhere": "the white banner immediately to the right of the green one, on the same post",
    "note": "Romania is Latin script and a Romance language sitting directly on Bulgaria's northern border. Getting used to reading it as clearly not-Slavic — and spotting Ă, Ș, Ț rather than the Slavic carons Č, Š, Ž — is one of the most useful discriminations available in the region.",
    "atlas": [
     {
      "key": "c:domains-phones",
      "label": "Domains and phone numbers on signage"
     },
     {
      "key": "n:Romania",
      "label": "Romania"
     }
    ]
   }
  },
  {
   "n": 10,
   "key": "France-Paris-4",
   "id": "8bfdd1f2-1ba0-4e9b-a471-67f8ec43dd92",
   "c": [
    2.333982,
    48.855548
   ],
   "url": "https://panoramax.ign.fr/api/pictures/8bfdd1f2-1ba0-4e9b-a471-67f8ec43dd92/hd.jpg",
   "t": "2025-05-05T09:59:01.181000+00:00",
   "pano": true,
   "country": "France",
   "area": "Paris",
   "kinds": [
    "amenity_named",
    "shop_named"
   ],
   "difficulty": "medium",
   "lesson": {
    "first": "The dark-green enamel plaque bolted flat to the corner stonework, reading 6ᵉ Arr¹ in the top band and RUE BONAPARTE below it.",
    "firstWhere": "turn to face the hoarding with the bed advertisement; the plaque is on the wall immediately to its left, at first-floor height",
    "narrows": "That plaque is a design, not just a name: dark green ground, a white bevelled border, white capitals, and a smaller top band. It is the French national street-plate pattern, and the top band carrying an arrondissement number narrows it further to Paris, Lyon or Marseille.",
    "second": "The hoarding itself reads JACQUARD FRANÇAIS and OUVERTURE PROCHAINE, with the small print En attendant nous vous accueillons au 53 rue Bonaparte. The cedilla in FRANÇAIS is the confirmation — French uses ç where Spanish, Italian and Romanian do not.",
    "secondWhere": "the large advertising hoarding across the shop window, centre of the frame",
    "note": "Street-name plates are worth learning as pictures rather than as words. Once you know the French green enamel, the Bulgarian blue-with-Latin-transliteration and the German white-on-blue, you can name three countries from a plate too small to read.",
    "atlas": [
     {
      "key": "c:street-furniture",
      "label": "Street furniture — signs, numbers, markers, bins"
     },
     {
      "key": "c:writing-system",
      "label": "Writing system and diacritics"
     }
    ]
   }
  },
  {
   "n": 11,
   "key": "Italy-Milan-2",
   "id": "a3d4a10a-b762-42ec-8da3-2710bb675ec4",
   "c": [
    9.192956,
    45.469969
   ],
   "url": "https://panoramax.openstreetmap.fr/images/a3/d4/a1/0a/b762-42ec-8da3-2710bb675ec4.jpg",
   "t": "2024-07-06T14:28:34.144459+00:00",
   "pano": false,
   "country": "Italy",
   "area": "Milan",
   "kinds": [
    "traffic_sign",
    "shop_named",
    "amenity_named",
    "tourism_info"
   ],
   "difficulty": "medium",
   "lesson": {
    "first": "The green oval sign on the corner of the pale building on the left: GRAND HOTEL ET DE MILAN, 1863.",
    "firstWhere": "left of centre, mounted on the building corner just above the awnings",
    "narrows": "It names the city, though in the French form Milan rather than the Italian Milano — hotel names of that vintage were often written in French for international guests, so do not let that push you towards France. Confirm it from the traffic signs instead.",
    "second": "The blue mandatory-direction sign on the right of the road carries 7.30 - 20.00 and the word eccetto: above a row of exemption pictograms. Eccetto is Italian for except. Above it is a red-ringed sign with the word zona — the marker for a Zona a Traffico Limitato, a restricted-traffic zone, which is a piece of street furniture you will only meet in Italian towns.",
    "secondWhere": "the tall sign post on the right-hand side of the crossing, at head height",
    "note": "Two details in that sign are Italian typographic habit rather than language: the time is punctuated with a full stop, 7.30, and the minutes are set smaller than the hours. Small conventions like that survive on signs where words are worn away.",
    "atlas": [
     {
      "key": "c:road-signs",
      "label": "Road signs — shape, colour, font"
     },
     {
      "key": "n:Italy",
      "label": "Italy"
     }
    ]
   }
  },
  {
   "n": 12,
   "key": "Spain-Madrid-5",
   "id": "4c19c6db-cb64-46ff-adf8-728b38ed89a7",
   "c": [
    -3.707283,
    40.408888
   ],
   "url": "https://panoramax.openstreetmap.fr/images/4c/19/c6/db/cb64-46ff-adf8-728b38ed89a7.jpg",
   "t": "2023-09-30T10:00:00+00:00",
   "pano": false,
   "country": "Spain",
   "area": "Madrid",
   "kinds": [
    "shop_named",
    "amenity_named"
   ],
   "difficulty": "medium",
   "lesson": {
    "first": "The purple banner across the top of the entrance: PARKING EMBAJADORES - EL RASTRO, ABIERTO 24 HORAS.",
    "firstWhere": "the top third of the frame, above the garage entrance",
    "narrows": "Spanish or Portuguese at a glance. Go to the white banner underneath to split them: ABONOS MENSUALES DESDE 100€, and in the small line below it PARA MÁS INFORMACIÓN. Spanish writes más and información with an acute accent and a -ción ending; Portuguese would write mais and informação with a tilde and a cedilla. There is no tilde and no ç anywhere here.",
    "second": "The same small line ends with the email address info@company.example, and the phone before it starts 91 — the .es domain is Spain, and 91 is the Madrid area code. The 100€ rules out Latin America, which shares the language but not the currency.",
    "secondWhere": "the fine print running along the bottom of the white banner",
    "note": "This is the ideal shape for a text clue: language, domain, currency and area code all on one wall, each of which alone would have been arguable.",
    "atlas": [
     {
      "key": "c:domains-phones",
      "label": "Domains and phone numbers on signage"
     },
     {
      "key": "n:Spain",
      "label": "Spain"
     }
    ]
   }
  },
  {
   "n": 13,
   "key": "Bulgaria-Burgas-6",
   "id": "0a1ad1ee-62da-4906-9fe1-e4f846a7be22",
   "c": [
    27.450577,
    42.51497
   ],
   "url": "https://panoramax.openstreetmap.fr/images/0a/1a/d1/ee/62da-4906-9fe1-e4f846a7be22.jpg",
   "t": "2021-03-19T10:00:00+00:00",
   "pano": false,
   "country": "Bulgaria",
   "area": "Burgas",
   "kinds": [
    "shop_named",
    "bus_stop",
    "amenity_named"
   ],
   "difficulty": "medium",
   "lesson": {
    "first": "АВТОМИВКА, in white capitals across the red gantry over the car-wash bay.",
    "firstWhere": "dead centre of the frame, on the red steel arch above the wash bays",
    "narrows": "Cyrillic again, but this time the word does the work rather than a letter. Russian for a car wash is АВТОМОЙКА, with a Й; Serbian is ауто перионица. АВТОМИВКА is built on the Bulgarian мивка, a washbasin, and belongs to Bulgarian and Macedonian.",
    "second": "Look past the gantry at the skyline. Those are панелки — prefabricated concrete panel blocks — and you can see the grid of panel joints on the grey block and the balconies glazed in individually, in mismatched frames, because each flat did its own. Some blocks have been re-rendered in bright colours since. That combination of panel grid plus mismatched balcony glazing is the standard Bulgarian residential skyline.",
    "secondWhere": "the row of tall residential blocks along the top left and centre of the frame",
    "note": "This is the useful pairing to practise: one language clue and one architecture clue that agree. Either alone would leave doubt, together they are solid.",
    "atlas": [
     {
      "key": "c:cyrillic-tells",
      "label": "Telling the Cyrillic countries apart"
     },
     {
      "key": "c:architecture",
      "label": "Architecture and roofing"
     },
     {
      "key": "n:Bulgaria",
      "label": "Bulgaria"
     }
    ]
   }
  },
  {
   "n": 14,
   "key": "Germany-Fulda-5",
   "id": "fe0c027f-f89e-4bf5-b686-4d1dc9f858f5",
   "c": [
    9.673273,
    50.556819
   ],
   "url": "https://panorama.osm-fulda.de/api/pictures/fe0c027f-f89e-4bf5-b686-4d1dc9f858f5/hd.jpg",
   "t": "2026-05-28T10:24:27.796000+00:00",
   "pano": true,
   "country": "Germany",
   "area": "Fulda",
   "kinds": [
    "bus_stop",
    "tourism_info",
    "route_ref",
    "traffic_sign"
   ],
   "difficulty": "medium",
   "lesson": {
    "first": "The blue-and-white street-name plate on the signal mast: Weimarer Straße.",
    "firstWhere": "turn towards the junction with the traffic lights and the clipped hedge; the plate is high on the green mast, above the signal heads",
    "narrows": "German-language street name, so Germany, Austria, Switzerland or Liechtenstein. Do not stop there — that is the mistake that makes German-speaking Europe feel unguessable.",
    "second": "Look at the last word: Straße, with an ß. Switzerland abolished ß in 1938 and writes Strasse, so Switzerland is out on one character. Then the plate itself: white text on a plain blue rectangle is the German convention, whereas Vienna uses white plates with a red border and a different typeface. Germany.",
    "secondWhere": "the same plate — the letter and the plate design are two separate clues on one object",
    "note": "This is the frame to remember when you draw a German-speaking country and freeze. There is almost always a written ß or ss somewhere, and it settles Switzerland immediately.",
    "atlas": [
     {
      "key": "c:writing-system",
      "label": "Writing system and diacritics"
     },
     {
      "key": "c:street-furniture",
      "label": "Street furniture — signs, numbers, markers, bins"
     }
    ]
   }
  },
  {
   "n": 15,
   "key": "Serbia-Belgrade-x8",
   "id": "93097a36-83d0-4a3a-b744-c93438748b13",
   "c": [
    20.465795,
    44.810282
   ],
   "url": "https://panoramax.osm-hr.org/permanent/93/09/7a/36/83d0-4a3a-b744-c93438748b13.jpg",
   "t": "2021-04-25T09:57:11.523000+00:00",
   "pano": false,
   "country": "Serbia",
   "area": "Belgrade",
   "kinds": [
    "tourism_info",
    "shop_named",
    "amenity_named"
   ],
   "difficulty": "hard",
   "lesson": {
    "first": "The tall blue sign on the pole at the top right. You will have to zoom in — at fit-to-window size it is just a blue smudge. It carries the same instruction twice around a yellow box-junction diagram: НЕ БЛОКИРАЈ РАСКРСНИЦУ above it in Cyrillic, NE BLOKIRAJ RASKRSNICU below it in Latin.",
    "firstWhere": "the top right corner, on the signpost standing in front of the tall stone building",
    "narrows": "Cyrillic, which is exactly where a Bulgarian frame would start too. This is the confusion the country set exists to break, and one letter breaks it: БЛОКИРАЈ ends in Ј. Ј does not exist in Bulgarian, Russian or Ukrainian Cyrillic. It is Serbian and Macedonian only. The rest of that family is Ђ, Љ, Њ, Ћ and Џ — find any one of the six and you are not in Bulgaria.",
    "second": "The sign hands you the proof of your own reading. The Latin line underneath spells the identical words, so you can lay them side by side and watch Ј line up with j, Ц with c, Ш with š. You never have to trust that you recognised the letter — the sign checks it for you.",
    "secondWhere": "the bottom half of the same sign, under the diagram",
    "note": "Two honest limits. Bulgaria also puts Latin transliterations on signs, so a bilingual layout by itself proves nothing — only the specific letter does. And there is no Ъ anywhere in this frame to hold up as a contrast, so you are identifying Serbia by a letter Bulgaria lacks rather than by seeing the two alphabets side by side. The furled tricolour on the pole to the far left hangs red-over-blue-over-white, which is the Serbian order, but a limp flag is weak evidence — treat it as agreement, not proof.",
    "atlas": [
     {
      "key": "c:cyrillic-tells",
      "label": "Telling the Cyrillic countries apart"
     },
     {
      "key": "n:Serbia",
      "label": "Serbia"
     },
     {
      "key": "n:Bulgaria",
      "label": "Bulgaria"
     }
    ]
   }
  },
  {
   "n": 16,
   "key": "Switzerland-Zurich-5",
   "id": "7f679251-4f9f-49b6-8656-3a4a1b30dc09",
   "c": [
    8.543291,
    47.375017
   ],
   "url": "https://panoramax.openstreetmap.fr/images/7f/67/92/51/4f9f-49b6-8656-3a4a1b30dc09.jpg",
   "t": "2024-06-07T08:19:29.340000+00:00",
   "pano": false,
   "country": "Switzerland",
   "area": "Zurich",
   "kinds": [
    "amenity_named",
    "shop_named"
   ],
   "difficulty": "hard",
   "lesson": {
    "first": "The rear number plate of the white van parked at the right kerb. Zoom into it: a white plate with black characters, a small red-and-white shield at its left end, and the characters AG·5124.",
    "firstWhere": "the white van filling the right-hand side of the frame, on its tailgate below the rear window",
    "narrows": "There is no blue EU band on the left of that plate. Every EU member puts one there, so a white European plate without it is a non-member — Switzerland, Norway, the UK or the Balkans outside the union. The red-and-white shield is the Swiss cross, and the two letters before the numbers are a canton code, here AG for Aargau. Only Switzerland puts a canton code and a shield on the plate that way.",
    "second": "The kerbside parking lines are painted yellow, not white or blue. Yellow road paint for parking and prohibition is a Swiss habit. And the small pale-blue-and-white flag on the mast at the left is the Zürich cantonal flag, flying beside the red Swiss one further down the street.",
    "secondWhere": "the continuous yellow line along the right-hand kerb in the foreground, and the flag on the pole across the road to the left",
    "note": "Plates are worth the zoom. Even when the digits are unreadable, the presence or absence of the blue EU band, and the colour of the plate, will split Europe in two.",
    "atlas": [
     {
      "key": "c:licence-plates",
      "label": "Licence plates"
     },
     {
      "key": "c:road-markings",
      "label": "Road markings"
     }
    ]
   }
  },
  {
   "n": 17,
   "key": "Croatia-Zagreb-2",
   "id": "dbb8bffb-c3d2-48c9-b17d-57f5cf7276b4",
   "c": [
    15.976969,
    45.804772
   ],
   "url": "https://panoramax.osm-hr.org/permanent/db/b8/bf/fb/c3d2-48c9-b17d-57f5cf7276b4.jpg",
   "t": "2026-05-29T17:48:28+00:00",
   "pano": false,
   "country": "Croatia",
   "area": "Zagreb",
   "kinds": [
    "amenity_named",
    "shop_named",
    "bus_stop",
    "route_ref"
   ],
   "difficulty": "hard",
   "lesson": {
    "first": "There is no readable text in this frame at all. Look up instead: two flags hang from the balcony of the ochre building on the right. The right-hand one has a red-and-white chequerboard on it.",
    "firstWhere": "the top right corner, on the first-floor balcony of the building with the arched doorway",
    "narrows": "That chequerboard is the šahovnica, and it is the only chequered field on any European national flag. The flag underneath it is a red-white-blue horizontal tricolour, which by itself is shared with Serbia, Slovakia, Slovenia and Russia — the chequered shield in the middle is what makes it Croatia.",
    "second": "The flag beside it is the EU circle of stars. Croatia joined the EU in 2013; Serbia, Bosnia and Montenegro have not. An EU flag flying on a public building in a Balkan city is itself a filter, and it agrees with the chequerboard.",
    "secondWhere": "the left-hand of the two flags on the same balcony",
    "note": "Flags are usually small, half-furled and in shadow, which is why beginners skip them. Get into the habit of checking balconies, gable ends and public-building forecourts before you conclude a frame has nothing in it.",
    "atlas": [
     {
      "key": "n:Croatia",
      "label": "Croatia"
     },
     {
      "key": "c:architecture",
      "label": "Architecture and roofing"
     }
    ]
   }
  },
  {
   "n": 18,
   "key": "Turkey-Ergene-4",
   "id": "779efc0d-3332-480d-843a-f234fac7e9d4",
   "c": [
    27.750897,
    41.205128
   ],
   "url": "https://panoramax.openstreetmap.fr/images/77/9e/fc/0d/3332-480d-843a-f234fac7e9d4.jpg",
   "t": "2026-06-21T14:48:32+00:00",
   "pano": true,
   "country": "Turkey",
   "area": "Ergene",
   "kinds": [
    "shop_named"
   ],
   "difficulty": "hard",
   "lesson": {
    "first": "A rural dual carriageway with no city name anywhere. Turn towards the green roadside restaurant across the stubble field: the banner on its wall ends BAHÇESİ.",
    "firstWhere": "the green single-storey building beyond the yellow wheat stubble, on the banner at its right-hand end",
    "narrows": "Two Turkish-only letters in one word: ç with a cedilla, and a capital İ carrying a dot. Turkish is the only language that writes a dotted capital İ. Bahçesi means garden, and it turns up constantly in the names of roadside restaurants and tea gardens, so it is a useful word to recognise on sight.",
    "second": "Turn about ninety degrees the other way. Behind the low houses stands a slim white pencil minaret, and a small red flag flies from the red-brick building beside it. Along the central reservation the kerbstones are painted in alternating yellow and black — a maintenance habit you see across Turkey and rarely in the EU.",
    "secondWhere": "look back along the road: the minaret is above the rooftops on the far side, and the painted kerbs run down the median in the foreground",
    "note": "This frame is in the set because it is the ordinary case. Most street imagery is not a city centre with a heritage sign; it is a road between fields, and you have to build the answer from an alphabet, a skyline and a kerbstone.",
    "atlas": [
     {
      "key": "c:writing-system",
      "label": "Writing system and diacritics"
     },
     {
      "key": "c:road-markings",
      "label": "Road markings"
     },
     {
      "key": "n:Turkey",
      "label": "Turkey"
     }
    ]
   }
  },
  {
   "n": 19,
   "key": "Austria-Vienna-3",
   "id": "8d406edc-1aac-4850-8d83-09bfae7caec2",
   "c": [
    16.357083,
    48.214446
   ],
   "url": "https://panoramax.openstreetmap.fr/images/8d/40/6e/dc/1aac-4850-8d83-09bfae7caec2.jpg",
   "t": "2021-03-05T13:39:34.974000+00:00",
   "pano": false,
   "country": "Austria",
   "area": "Vienna",
   "kinds": [
    "amenity_named",
    "shop_named"
   ],
   "difficulty": "hard",
   "lesson": {
    "first": "The pair of round signs stacked on the red mast at the tram platform. The upper one is black-ringed and reads AUTOBUS HALTESTELLE; the lower one is red-ringed and reads STRASSENBAHN HALTESTELLE.",
    "firstWhere": "left of centre, on the slim red post standing on the platform between you and the buildings",
    "narrows": "Haltestelle is German, so German-speaking Europe. There is no ß to help you here — the sign is set in capitals, where ß is conventionally written SS — so you have to identify the country from the object rather than the word.",
    "second": "The stop sign is the tell. A German bus stop is a green H in a yellow disc. A Swiss stop is a yellow flag with the operator's trademark. Vienna uses exactly this: two separate circular discs on one mast, one ringed black for buses and one ringed red for trams, each carrying the Wiener Linien roundel. The tram itself is the matching red-and-white livery, in the Austrian national colours.",
    "secondWhere": "the two discs themselves, and the long tram filling the right half of the frame",
    "note": "Austria is the hardest of the German-speaking three, because so much of its signage matches Germany's. Public-transport furniture is where it differs most reliably, so learn the Vienna stop discs specifically.",
    "atlas": [
     {
      "key": "c:street-furniture",
      "label": "Street furniture — signs, numbers, markers, bins"
     },
     {
      "key": "c:writing-system",
      "label": "Writing system and diacritics"
     }
    ]
   }
  }
 ]
};
