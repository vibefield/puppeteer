#!/usr/bin/env python3
"""Extract schema only from Antigravity's uncompressed proto3 file descriptors.

Development dependency: protobuf==7.36.2. This does not execute the binary or read
conversation stores. Unknown nested messages remain unknown in the writer schema.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path

from google.protobuf import descriptor_pb2, json_format

FILES = (
    'third_party/jetski/cortex_pb/cortex.proto',
    'third_party/jetski/codeium_common_pb/codeium_common.proto',
    'google/protobuf/timestamp.proto',
)
MESSAGES = (
    'exa.cortex_pb.CortexStepMetadata',
    'exa.cortex_pb.CortexStepGeneratorMetadata',
    'exa.cortex_pb.ChatModelMetadata',
    'exa.cortex_pb.RetryInfo',
    'exa.codeium_common_pb.ModelUsageStats',
    'google.protobuf.Timestamp',
)


def read_varint(data, position, limit):
    value = 0
    for shift in range(0, 70, 7):
        if position >= limit:
            raise ValueError('truncated descriptor varint')
        byte = data[position]
        position += 1
        if shift == 63 and byte > 1:
            raise ValueError('overflowing descriptor varint')
        value |= (byte & 127) << shift
        if byte < 128:
            return value, position
    raise ValueError('invalid descriptor varint')


def extract_descriptor(binary, name):
    encoded = name.encode()
    if len(encoded) >= 128:
        raise ValueError('unsupported descriptor name length')
    prefix = b'\x0a' + bytes([len(encoded)]) + encoded
    start = binary.find(prefix)
    if start < 0 or binary.find(prefix, start + 1) >= 0:
        raise ValueError(f'descriptor must occur exactly once: {name}')
    position = start
    limit = min(len(binary), start + 5_000_000)
    fields = set()
    while position < limit:
        tag, position = read_varint(binary, position, limit)
        field, wire = tag >> 3, tag & 7
        if field not in range(1, 13):
            raise ValueError('unreviewed FileDescriptorProto field')
        fields.add(field)
        value = None
        if wire == 0:
            _, position = read_varint(binary, position, limit)
        elif wire in (1, 5):
            position += 8 if wire == 1 else 4
        elif wire == 2:
            length, position = read_varint(binary, position, limit)
            end = position + length
            if end > limit:
                raise ValueError('truncated or oversized descriptor')
            value = binary[position:end]
            position = end
        else:
            raise ValueError('unsupported descriptor wire type')
        if position > limit:
            raise ValueError('truncated descriptor')
        if field == 12:
            if value != b'proto3' or not {1, 2, 4}.issubset(fields):
                raise ValueError('expected a named proto3 file with messages')
            raw = binary[start:position]
            descriptor = descriptor_pb2.FileDescriptorProto.FromString(raw)
            if descriptor.name != name or descriptor.syntax != 'proto3':
                raise ValueError('descriptor identity differs')
            return descriptor, raw, start
    raise ValueError('missing proto3 syntax terminator')


def writer_records(messages):
    def shape(name, parents=()):
        if name not in messages or name in parents:
            return {'kind': 'unknown'}
        fields = {}
        for field in sorted(messages[name].field, key=lambda item: item.name):
            if field.type == field.TYPE_MESSAGE:
                value = shape(field.type_name.lstrip('.'), (*parents, name))
            elif field.type == field.TYPE_STRING:
                value = {'kind': 'string'}
            elif field.type == field.TYPE_BOOL:
                value = {'kind': 'boolean'}
            elif field.type in (field.TYPE_BYTES, field.TYPE_GROUP):
                value = {'kind': 'unknown'}
            else:
                value = {'kind': 'number'}
            if field.label == field.LABEL_REPEATED:
                value = {'kind': 'array', 'items': value}
            fields[f'{field.name}#{field.number}'] = {'shape': value, 'required': False}
        return {'kind': 'object', 'fields': fields}
    return {name: {'observed': 0, 'shape': shape(name)} for name in MESSAGES}


def extract(binary, version):
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('an exact release version is required')
    provenance = {'binarySha256': hashlib.sha256(binary).hexdigest(), 'files': []}
    messages = {}
    for name in FILES:
        descriptor, raw, start = extract_descriptor(binary, name)
        provenance['files'].append({
            'name': name, 'offset': start, 'length': len(raw),
            'sha256': hashlib.sha256(raw).hexdigest(),
        })
        for message in descriptor.message_type:
            full_name = f'{descriptor.package}.{message.name}'
            if full_name in MESSAGES:
                if full_name in messages:
                    raise ValueError('duplicate selected message')
                messages[full_name] = message
    if set(messages) != set(MESSAGES):
        raise ValueError('required writer message is missing')
    document = {
        'format': 'rosetta-groundtruth/1', 'agent': 'antigravity',
        'agent_version': version, 'writer_version': version, 'evidence': 'writer',
        'generator': f'Antigravity {version} embedded FileDescriptorProto extraction; schema only, no payloads; see extraction.json and artifact.json',
        'data_root': '~/.gemini/antigravity-cli',
        'streams': [{
            'id': 'conversation-db', 'glob': 'conversations/*.db*',
            'file_format': 'sqlite', 'discipline': 'database', 'evidence': 'writer',
            'notes': 'Descriptor evidence establishes field numbers and types only. Store layout, occurrence, token accounting and response semantics require independent runtime evidence.',
            'discriminator': 'table', 'facets': [{
                'id': 'protobuf',
                'path': 'steps.metadata / gen_metadata.data; candidate bindings inherited from the prior survey, requiring runtime validation for this release',
                'discriminator': 'message', 'record_types': writer_records(messages),
            }],
        }],
    }
    selected = {name: json_format.MessageToDict(value, preserving_proto_field_name=True)
                for name, value in sorted(messages.items())}
    return document, provenance, selected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    binary = args.binary.read_bytes()
    if hashlib.sha256(binary).hexdigest() != args.sha256:
        raise ValueError('binary does not match the reviewed SHA-256')
    document, provenance, selected = extract(binary, args.version)
    args.output.mkdir(parents=True, exist_ok=True)
    for name, value in [('writer.json', document), ('extraction.json', provenance),
                        ('selected-descriptors.json', selected)]:
        (args.output / name).write_text(json.dumps(value, indent=2) + '\n')
    print(f'extracted {len(selected)} writer messages from {args.sha256}')


if __name__ == '__main__':
    main()
