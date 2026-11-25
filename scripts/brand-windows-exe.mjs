import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit';

const [executable, markPath, product, version] = process.argv.slice(2);
assert.equal(basename(executable), product + '.exe');
const [major, minor, patch] = version.split('-')[0].split('.').map(Number);
assert.ok([major, minor, patch].every(part => Number.isInteger(part) && part >= 0 && part <= 65535));

const [source, mark] = await Promise.all([readFile(executable), readFile(markPath)]);
assert.ok(mark.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')));
assert.equal(mark.toString('ascii', 12, 16), 'IHDR');
const width = mark.readUInt32BE(16);
const height = mark.readUInt32BE(20);
assert.ok(width === height && width >= 16 && width <= 256 && mark[24] === 8 && mark[25] === 6,
  'Use the square RGBA Hyper Bot mark.');

const image = NtExecutable.from(source);
const resources = NtExecutableResource.from(image);
const codeSections = image.getAllSections().filter(section => section.info.name !== '.rsrc');
const otherResources = resources.entries.filter(entry => ![3, 14, 16].includes(entry.type));
const icons = Resource.IconGroupEntry.fromEntries(resources.entries);
const versions = Resource.VersionInfo.fromEntries(resources.entries);
assert.equal(icons.length, 1, 'Expected the pinned Electron application icon.');
assert.equal(versions.length, 1, 'Expected the pinned Electron version resource.');
const [group] = icons;
const [info] = versions;
const languages = info.getAllLanguagesForStringValues();
assert.equal(languages.length, 1, 'Expected one Electron version-information language.');
const [language] = languages;
const upstreamCopyright = info.getStringValues(language).LegalCopyright;

Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang,
  [Data.RawIconItem.from(mark, width, height, 32)]);
info.setFileVersion(major, minor, patch, 0);
info.setProductVersion(major, minor, patch, 0);
// The product name comes from the application. The upstream copyright stays in the resource.
info.removeStringValue(language, 'CompanyName', false);
const identity = {
  ProductName: product,
  FileDescription: product,
  InternalName: product,
  OriginalFilename: basename(executable),
  FileVersion: version,
  ProductVersion: version,
};
info.setStringValues(language, identity);
info.outputToResourceEntries(resources.entries);
resources.outputResource(image);

const branded = Buffer.from(image.generate());
const rewritten = NtExecutable.from(branded);
const checked = NtExecutableResource.from(rewritten);
const newSections = rewritten.getAllSections().filter(section => section.info.name !== '.rsrc');
assert.deepEqual(newSections.map(section => section.info.name), codeSections.map(section => section.info.name));
for (const [index, section] of newSections.entries()) {
  assert.ok(Buffer.from(section.data).equals(Buffer.from(codeSections[index].data)), section.info.name);
}
const unmodified = checked.entries.filter(entry => ![3, 14, 16].includes(entry.type));
const identifiers = entries => entries.map(({ type, id, lang, codepage }) => [type, id, lang, codepage]);
assert.deepEqual(identifiers(unmodified), identifiers(otherResources), 'Unexpected Electron resource identifiers.');
for (const [index, entry] of unmodified.entries()) {
  assert.ok(Buffer.from(entry.bin).equals(Buffer.from(otherResources[index].bin)), 'Resource ' + entry.type + '/' + entry.id);
}
const [newGroup] = Resource.IconGroupEntry.fromEntries(checked.entries);
const [newIcon] = newGroup.getIconItemsFromEntries(checked.entries);
assert.ok(Buffer.from(newIcon.bin).equals(mark), 'The application icon must match the approved mark.');
const [newInfo] = Resource.VersionInfo.fromEntries(checked.entries);
const strings = newInfo.getStringValues(language);
for (const [key, value] of Object.entries(identity)) assert.equal(strings[key], value, key);
assert.equal(strings.LegalCopyright, upstreamCopyright);
await writeFile(executable, branded);
