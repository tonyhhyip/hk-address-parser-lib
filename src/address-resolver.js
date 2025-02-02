import ogcioParser from "./ogcio-parser";
import * as AddressFactory from "./models/address-factory";
import ProjConvertor from "./utils/proj-convertor";
import { sortLandResult } from "./land-sorter";
import "cross-fetch/polyfill";
import * as async from 'async';
import asyncify from 'async/asyncify';

const OGCIO_RECORD_COUNT = 200;
const NEAR_THRESHOLD = 0.05; // 50 metre

/**
 *
 * @param {string} address
 * @param {object} options
 * @returns Promise<Address[]>
 */
async function searchAddressWithOGCIO(address, { limit = OGCIO_RECORD_COUNT }) {
  const ogcioURL = `https://www.als.ogcio.gov.hk/lookup?q=${encodeURIComponent(address)}&n=${limit}`;
  const ogcioRes = await fetch(ogcioURL, {
    method: "GET",
    mode: "cors",
    headers: {
      "Accept": "application/json",
      "Accept-Language": "en,zh-Hant",
      "Accept-Encoding": "gzip",
    }
  });
  const ogcioData = await ogcioRes.json();
  return ogcioParser.searchResult(address, ogcioData)
    .map(record => AddressFactory.createAddress("ogcio", record));
}

export async function searchAddressFromLand(address) {
  const landsURL = `https://geodata.gov.hk/gs/api/v1.0.0/locationSearch?q=${encodeURI(address)}`;
  const resp = await fetch(landsURL, {
    method: "GET",
    mode: "cors",
  });
  const landsData = resp.json();
  const landRecords =  landsData.map((data) => {
    const [wgsLng, wgslat] = ProjConvertor.projTransform("EPSG:2326", "EPSG:4326", [data.x, data.y]);
    const mapData = {
      ...data,
      lat: Number.parseFloat(wgslat).toFixed(4),
      lng: Number.parseFloat(wgsLng).toFixed(4),
    };
    return AddressFactory.createAddress("land", mapData);
  });

  return sortLandResult(address, landRecords);
}

function queryIteratorFunc(item) {
  return asyncify(() => queryAddress(item));
}

async function queryAddress(address) {
  // Fetch result from OGCIO
  let sortedOgcioRecords = await searchAddressWithOGCIO(address);
  const landRecords = await searchAddressFromLand(address);

  const sortedResults = [];

  // console.log(sortedOgcioRecords.map(rec => ({address: rec.fullAddress("chi"), score: rec.record.score})));
  // P.S. Result source (OGCIO/Land Department) should be displayed to user
  // this.results["source"] = ...


  // If the land record have any exception
  if (landRecords.length === 0) {
    return sortedOgcioRecords;
  }

  // 1. Best Case: Top OGCIO result appears in land result(s)
  // We compared with the first in land result but some cases that sometime the most accurate result does not appear at top
  // so we should search among the whole list
  for (const landResult of landRecords) {
    if (sortedOgcioRecords[0].distanceTo(landResult) < NEAR_THRESHOLD) {
      // console.log("1. Best Case: Land result and ogcio return the same address");
      return sortedOgcioRecords;
    }
  }


  // 2. best result from OGCIO does not appears in the land results
  // so we pick the first land result as our destination and search all the OGCIO results and see if some result is within the NEAR_DISTANCE
  // and sort them with distance to the first land result


  sortedOgcioRecords.forEach(ogcioRecord => {
    const distance = ogcioRecord.distanceTo(landRecords[0]);
    if (ogcioRecord.distanceTo(landRecords[0]) < NEAR_THRESHOLD) {
      // add the distance for sorting the array
      ogcioRecord.distance = distance;
      sortedResults.push(ogcioRecord);
      // console.log(ogcioRecord.distanceTo(landRecords[0]) + " | " + ogcioRecord.fullAddress("chi"))
    }
  });

  // console.log("2. first land result appears in ogcio result")
  // Return the sorted array by distnace to first land result
  if (sortedResults.length > 0) {
    return sortedResults.sort((a, b) => a.distance - b.distance);
  }

  // 3. ogcio not found but there is land result. We try to search again from ogcio using the land result
  // #89
  const assumedLandResult = landRecords[0];
  const fullAddressToSearch = landRecords[0].fullAddress("chi");
  if (fullAddressToSearch !== '') {
    sortedOgcioRecords = await searchAddressWithOGCIO(fullAddressToSearch);
    if (sortedOgcioRecords[0].distanceTo(assumedLandResult) < NEAR_THRESHOLD) {
      // 3.1 second round result is the nearest result
      return sortedOgcioRecords;
    }

    // QUESTION: shall we loop through the ogcio records again?
  }

  return landRecords;
}

async function batchQueryAddresses(addresses, options = { limit: 10 }) {
  return new Promise((resolve, reject) => {
    async.parallelLimit(addresses.map(address => queryIteratorFunc(address)), options.limit, (err, results) => {
      if (err) {
        return reject(err);
      }

      resolve(results);
    })
  });
}


export default {
  queryAddress,
  batchQueryAddresses,
}
