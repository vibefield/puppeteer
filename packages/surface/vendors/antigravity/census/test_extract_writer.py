"""Run with the same pinned protobuf development environment as extract-writer.py."""
import importlib.util
import unittest
from pathlib import Path

from google.protobuf import descriptor_pb2

spec = importlib.util.spec_from_file_location('extract_writer', Path(__file__).with_name('extract-writer.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def descriptor():
    value = descriptor_pb2.FileDescriptorProto(name='test.proto', package='test', syntax='proto3')
    message = value.message_type.add(name='Message')
    message.field.add(name='value', number=1, type=9, label=1)
    return value.SerializeToString()


class DescriptorExtractionTests(unittest.TestCase):
    def test_embedded_descriptor_excludes_surrounding_binary_bytes(self):
        raw = descriptor()
        value, extracted, offset = module.extract_descriptor(b'prefix' + raw + b'non-protobuf-suffix', 'test.proto')
        self.assertEqual(offset, 6)
        self.assertEqual(extracted, raw)
        self.assertEqual(value.message_type[0].field[0].name, 'value')

    def test_missing_and_ambiguous_descriptors_are_rejected(self):
        for data in (b'no descriptor', descriptor() * 2):
            with self.subTest(data=data), self.assertRaisesRegex(ValueError, 'exactly once'):
                module.extract_descriptor(data, 'test.proto')

    def test_truncation_and_wrong_syntax_are_rejected(self):
        raw = descriptor()
        for data in (raw[:-1], raw.replace(b'proto3', b'proto2'), raw[:-8] + b'\x62\xff' * 10):
            with self.subTest(data=data), self.assertRaises(ValueError):
                module.extract_descriptor(data, 'test.proto')

    def test_unknown_top_level_fields_require_review(self):
        raw = descriptor()
        with self.assertRaisesRegex(ValueError, 'unreviewed'):
            module.extract_descriptor(raw[:-8] + b'\x68\x01' + raw[-8:], 'test.proto')

    def test_writer_preserves_repeated_fields_without_inventing_nested_shapes(self):
        messages = {}
        for name in module.MESSAGES:
            value = descriptor_pb2.DescriptorProto(name=name.rsplit('.', 1)[-1])
            value.field.add(name='opaque', number=3, type=11, type_name='.unreviewed.Message', label=3)
            value.field.add(name='token_count', number=9, type=4, label=1)
            messages[name] = value
        records = module.writer_records(messages)
        fields = records[module.MESSAGES[0]]['shape']['fields']
        self.assertEqual(fields['opaque#3'], {'shape': {'kind': 'array', 'items': {'kind': 'unknown'}}, 'required': False})
        self.assertEqual(fields['token_count#9'], {'shape': {'kind': 'number'}, 'required': False})
        self.assertEqual(records[module.MESSAGES[0]]['observed'], 0)


if __name__ == '__main__':
    unittest.main()
